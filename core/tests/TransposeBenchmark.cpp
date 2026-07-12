/**
 * @file TransposeBenchmark.cpp
 * @brief Offline benchmark harness for the transpose/pitch effect family.
 *
 * For each (effect variant x semitone setting x demo sample) pass this tool:
 *   - renders the demo audio through a fresh effect instance,
 *   - records reported latency (GetLatencySamples) and measured latency
 *     (envelope cross-correlation between input and output),
 *   - records processing cost (total, average and worst block time,
 *     realtime factor),
 *   - writes a latency-compensated WAV render for audible comparison.
 *
 * Results are written to <outputRoot>/<snapshot>/results.json plus WAV files.
 * Use tools/transpose-benchmark/generate_report.py to build an HTML report
 * comparing one or more snapshots (e.g. different git revisions).
 *
 * Usage:
 *   TransposeBenchmark [--all-demo-audio] [outputRoot] [snapshotLabel]
 *     --all-demo-audio  render all demo inputs (default renders first riff only)
 *     outputRoot    default: transpose-benchmark-out (relative to cwd)
 *     snapshotLabel default: snapshot-<UTC timestamp>
 */

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "dsp/EffectProcessor.h"
#include "dsp/EffectRegistry.h"
#include "dsp/effects/BuiltinEffects.h"
#include "util/Wav.h"

#ifndef GUITARFX_DEMO_AUDIO_DIR
#error "GUITARFX_DEMO_AUDIO_DIR must be defined"
#endif

namespace fs = std::filesystem;

namespace
{
  constexpr int kBlockSize = 512;
  constexpr double kMaxRenderSeconds = 12.0;
  constexpr int kEnvelopeDecimation = 32;
  constexpr double kMaxMeasuredLatencySeconds = 0.5;

  struct EffectVariant
  {
    std::string alias;       // registry alias, e.g. "transpose"
    std::string label;       // report label, e.g. "Transpose (STFT, polyphonic)"
    std::vector<std::pair<std::string, double>> extraParams;
  };

  struct ExternalPluginVariant
  {
    std::string pluginId;
    std::string label;
    std::string pluginPath;
    std::string stateConfigKey = "pluginStateBase64";
    std::map<int, std::string> stateBySemitone;
  };

  const std::vector<EffectVariant> kVariants = {
    {"pitch_shift", "Pitch Shift (Signalsmith)", {}},
    {"transpose", "Transpose (Signalsmith)", {}},
    {"transpose_stft", "Transpose (STFT, low latency)", {{"mode", 0.0}}},
    {"transpose_stft", "Transpose (STFT, polyphonic)", {{"mode", 1.0}}},
    {"transpose_hybrid", "Transpose (Hybrid)", {}},
  };

  const std::vector<int> kSemitoneSettings = {-12, -7, -5, -3, -2, -1, 0, 2, 5, 7, 12};

  const std::vector<std::string> kDemoSamples = {
    "guitar-riff-01.wav",
    "guitar-riff-02.wav",
    "DI_Guitar_L.wav",
  };

  const fs::path kExternalPluginsCollectionRelPath =
    fs::path("tools") / "transpose-benchmark" / "external-plugins.json";

  struct StereoAudio
  {
    double sampleRate = 0.0;
    std::vector<float> left;
    std::vector<float> right;

    [[nodiscard]] size_t frames() const { return left.size(); }
  };

  std::vector<std::uint8_t> ReadBinaryFile(const fs::path& path)
  {
    std::ifstream input(path, std::ios::binary);
    if (!input)
      return {};
    return std::vector<std::uint8_t>(std::istreambuf_iterator<char>(input),
                                     std::istreambuf_iterator<char>());
  }

  std::optional<StereoAudio> LoadDemoSample(const fs::path& path)
  {
    const auto bytes = ReadBinaryFile(path);
    if (bytes.empty())
      return std::nullopt;

    const auto decoded = guitarfx::util::DecodePcmWav(bytes);
    if (!decoded || decoded->channelSamples.empty() || decoded->sampleRate <= 0.0)
      return std::nullopt;

    StereoAudio audio;
    audio.sampleRate = decoded->sampleRate;

    const size_t maxFrames = static_cast<size_t>(kMaxRenderSeconds * decoded->sampleRate);
    const auto& srcL = decoded->channelSamples[0];
    const auto& srcR = decoded->channelSamples.size() > 1 ? decoded->channelSamples[1]
                                                          : decoded->channelSamples[0];
    const size_t frames = std::min(std::min(srcL.size(), srcR.size()), maxFrames);

    audio.left.resize(frames);
    audio.right.resize(frames);
    for (size_t i = 0; i < frames; ++i)
    {
      audio.left[i] = static_cast<float>(srcL[i]);
      audio.right[i] = static_cast<float>(srcR[i]);
    }
    return audio;
  }

  bool WriteWav16(const fs::path& path, const StereoAudio& audio)
  {
    std::ofstream out(path, std::ios::binary);
    if (!out)
      return false;

    const std::uint32_t frames = static_cast<std::uint32_t>(audio.frames());
    const std::uint16_t channels = 2;
    const std::uint16_t bitsPerSample = 16;
    const std::uint32_t sampleRate = static_cast<std::uint32_t>(std::lround(audio.sampleRate));
    const std::uint32_t byteRate = sampleRate * channels * (bitsPerSample / 8);
    const std::uint16_t blockAlign = channels * (bitsPerSample / 8);
    const std::uint32_t dataSize = frames * blockAlign;
    const std::uint32_t riffSize = 36 + dataSize;

    auto write32 = [&](std::uint32_t v) { out.write(reinterpret_cast<const char*>(&v), 4); };
    auto write16 = [&](std::uint16_t v) { out.write(reinterpret_cast<const char*>(&v), 2); };

    out.write("RIFF", 4);
    write32(riffSize);
    out.write("WAVE", 4);
    out.write("fmt ", 4);
    write32(16);
    write16(1); // PCM
    write16(channels);
    write32(sampleRate);
    write32(byteRate);
    write16(blockAlign);
    write16(bitsPerSample);
    out.write("data", 4);
    write32(dataSize);

    for (std::uint32_t i = 0; i < frames; ++i)
    {
      const auto clampToInt16 = [](float v)
      {
        const float clamped = std::clamp(v, -1.0f, 1.0f);
        return static_cast<std::int16_t>(std::lround(clamped * 32767.0f));
      };
      const std::int16_t l = clampToInt16(audio.left[i]);
      const std::int16_t r = clampToInt16(audio.right[i]);
      out.write(reinterpret_cast<const char*>(&l), 2);
      out.write(reinterpret_cast<const char*>(&r), 2);
    }
    return static_cast<bool>(out);
  }

  /**
   * Decimated rectified-envelope of a mono mix. Pitch shifting changes the
   * waveform but largely preserves the amplitude envelope, so cross-correlating
   * envelopes gives a robust latency estimate even for shifted material.
   */
  std::vector<double> ComputeEnvelope(const std::vector<float>& left,
                                      const std::vector<float>& right,
                                      double sampleRate)
  {
    const double smoothingSeconds = 0.005;
    const double alpha = 1.0 - std::exp(-1.0 / (smoothingSeconds * sampleRate));

    std::vector<double> envelope;
    envelope.reserve(left.size() / kEnvelopeDecimation + 1);
    double state = 0.0;
    for (size_t i = 0; i < left.size(); ++i)
    {
      const double mono = 0.5 * (std::abs(static_cast<double>(left[i]))
                                 + std::abs(static_cast<double>(right[i])));
      state += alpha * (mono - state);
      if (i % kEnvelopeDecimation == 0)
        envelope.push_back(state);
    }
    return envelope;
  }

  /**
   * Estimate output delay (in frames) via normalized cross-correlation of the
   * decimated envelopes. Resolution is +/- kEnvelopeDecimation frames.
   * Returns -1 when correlation is too weak to be trusted.
   */
  int MeasureLatencyFrames(const StereoAudio& input, const StereoAudio& output)
  {
    const auto inputEnv = ComputeEnvelope(input.left, input.right, input.sampleRate);
    const auto outputEnv = ComputeEnvelope(output.left, output.right, output.sampleRate);
    if (inputEnv.size() < 16 || outputEnv.size() < 16)
      return -1;

    const int maxLag = static_cast<int>(kMaxMeasuredLatencySeconds * input.sampleRate)
                       / kEnvelopeDecimation;
    const int usableLag = std::min<int>(maxLag, static_cast<int>(outputEnv.size()) - 8);
    if (usableLag <= 0)
      return -1;

    double inputEnergy = 0.0;
    for (const double v : inputEnv)
      inputEnergy += v * v;
    if (inputEnergy <= 1.0e-12)
      return -1;

    int bestLag = 0;
    double bestScore = -1.0;
    for (int lag = 0; lag <= usableLag; ++lag)
    {
      double dot = 0.0;
      double outEnergy = 0.0;
      const size_t count = std::min(inputEnv.size(), outputEnv.size() - static_cast<size_t>(lag));
      for (size_t i = 0; i < count; ++i)
      {
        const double o = outputEnv[i + static_cast<size_t>(lag)];
        dot += inputEnv[i] * o;
        outEnergy += o * o;
      }
      if (outEnergy <= 1.0e-12)
        continue;
      const double score = dot / std::sqrt(inputEnergy * outEnergy);
      if (score > bestScore)
      {
        bestScore = score;
        bestLag = lag;
      }
    }

    if (bestScore < 0.5)
      return -1;
    return bestLag * kEnvelopeDecimation;
  }

  struct PassResult
  {
    nlohmann::json stats;
    StereoAudio render;
  };

  std::optional<PassResult> RunConfiguredPass(const std::string& alias,
                                              const std::string& label,
                                              const StereoAudio& input,
                                              const std::function<void(guitarfx::EffectProcessor&)>& configure)
  {
    auto& registry = guitarfx::EffectRegistry::Instance();
    const std::string resolvedType = registry.Resolve(alias);
    auto effect = registry.Create(resolvedType);
    if (!effect)
    {
      std::cerr << "  SKIP: cannot create effect '" << label << "' (alias='" << alias << "')\n";
      return std::nullopt;
    }

    configure(*effect);
    effect->Prepare(input.sampleRate, kBlockSize);
    effect->Reset();

    const int reportedLatency = effect->GetLatencySamples();
    const size_t inputFrames = input.frames();
    const size_t flushFrames = static_cast<size_t>(std::max(reportedLatency, 0)) + 8192;
    const size_t totalFrames = inputFrames + flushFrames;

    StereoAudio raw;
    raw.sampleRate = input.sampleRate;
    raw.left.assign(totalFrames, 0.0f);
    raw.right.assign(totalFrames, 0.0f);

    std::vector<float> inL(kBlockSize, 0.0f);
    std::vector<float> inR(kBlockSize, 0.0f);
    std::vector<float> outL(kBlockSize, 0.0f);
    std::vector<float> outR(kBlockSize, 0.0f);
    float* inputs[2] = {inL.data(), inR.data()};
    float* outputs[2] = {outL.data(), outR.data()};

    using Clock = std::chrono::steady_clock;
    std::chrono::nanoseconds totalNs{0};
    std::chrono::nanoseconds maxBlockNs{0};
    size_t timedBlocks = 0;

    for (size_t pos = 0; pos < totalFrames; pos += kBlockSize)
    {
      const int blockFrames = static_cast<int>(std::min<size_t>(kBlockSize, totalFrames - pos));
      for (int i = 0; i < blockFrames; ++i)
      {
        const size_t idx = pos + static_cast<size_t>(i);
        inL[static_cast<size_t>(i)] = idx < inputFrames ? input.left[idx] : 0.0f;
        inR[static_cast<size_t>(i)] = idx < inputFrames ? input.right[idx] : 0.0f;
      }

      const auto start = Clock::now();
      effect->Process(inputs, outputs, blockFrames);
      const auto elapsed = Clock::now() - start;

      if (timedBlocks > 0)
        maxBlockNs = std::max(maxBlockNs, std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed));
      totalNs += std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed);
      ++timedBlocks;

      for (int i = 0; i < blockFrames; ++i)
      {
        raw.left[pos + static_cast<size_t>(i)] = outL[static_cast<size_t>(i)];
        raw.right[pos + static_cast<size_t>(i)] = outR[static_cast<size_t>(i)];
      }
    }

    const int measuredLatency = MeasureLatencyFrames(input, raw);

    StereoAudio render;
    render.sampleRate = input.sampleRate;
    render.left.assign(inputFrames, 0.0f);
    render.right.assign(inputFrames, 0.0f);
    const size_t offset = static_cast<size_t>(std::max(reportedLatency, 0));
    for (size_t i = 0; i < inputFrames && (i + offset) < totalFrames; ++i)
    {
      render.left[i] = raw.left[i + offset];
      render.right[i] = raw.right[i + offset];
    }

    double peak = 0.0;
    double sumSquares = 0.0;
    for (size_t i = 0; i < inputFrames; ++i)
    {
      const double l = std::abs(static_cast<double>(render.left[i]));
      const double r = std::abs(static_cast<double>(render.right[i]));
      peak = std::max({peak, l, r});
      sumSquares += 0.5 * (l * l + r * r);
    }
    const double rms = inputFrames > 0 ? std::sqrt(sumSquares / static_cast<double>(inputFrames)) : 0.0;

    const double audioMs = 1000.0 * static_cast<double>(totalFrames) / input.sampleRate;
    const double processMs = std::chrono::duration<double, std::milli>(totalNs).count();
    const double avgBlockUs = timedBlocks > 0
      ? std::chrono::duration<double, std::micro>(totalNs).count() / static_cast<double>(timedBlocks)
      : 0.0;

    const auto toDb = [](double v) { return v > 1.0e-9 ? 20.0 * std::log10(v) : -180.0; };
    const auto toMs = [&](int samples) { return 1000.0 * static_cast<double>(samples) / input.sampleRate; };

    nlohmann::json stats;
    stats["reportedLatencySamples"] = reportedLatency;
    stats["reportedLatencyMs"] = toMs(reportedLatency);
    stats["measuredLatencySamples"] = measuredLatency;
    stats["measuredLatencyMs"] = measuredLatency >= 0 ? toMs(measuredLatency) : -1.0;
    if (measuredLatency >= 0)
      stats["latencyDeltaSamples"] = measuredLatency - reportedLatency;
    else
      stats["latencyDeltaSamples"] = nullptr;
    stats["processMs"] = processMs;
    stats["audioMs"] = audioMs;
    stats["realtimeFactor"] = processMs > 0.0 ? audioMs / processMs : 0.0;
    stats["avgBlockUs"] = avgBlockUs;
    stats["maxBlockUs"] = std::chrono::duration<double, std::micro>(maxBlockNs).count();
    stats["peakDb"] = toDb(peak);
    stats["rmsDb"] = toDb(rms);

    PassResult result;
    result.stats = std::move(stats);
    result.render = std::move(render);
    return result;
  }

  std::optional<PassResult> RunPass(const EffectVariant& variant,
                                    int semitones,
                                    const StereoAudio& input)
  {
    return RunConfiguredPass(variant.alias,
                             variant.label,
                             input,
                             [&](guitarfx::EffectProcessor& effect)
                             {
                               // Set params before Prepare so preloaded values are picked up (see repo
                               // memory: TransposeEffect only applies preloaded semitones during Prepare).
                               effect.SetParam("semitones", static_cast<double>(semitones));
                               effect.SetParam("mix", 1.0);
                               for (const auto& [key, value] : variant.extraParams)
                                 effect.SetParam(key, value);
                             });
  }

  std::string DefaultSnapshotLabel()
  {
    const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm utc{};
#if defined(_WIN32)
    gmtime_s(&utc, &now);
#else
    gmtime_r(&now, &utc);
#endif
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "snapshot-%Y%m%d-%H%M%S", &utc);
    return buffer;
  }

  std::string SanitizeForFilename(std::string value)
  {
    for (char& c : value)
    {
      if (!std::isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_')
        c = '_';
    }
    return value;
  }

  std::optional<fs::path> FindExternalPluginCollectionPath()
  {
    fs::path current = fs::current_path();
    for (int i = 0; i < 6; ++i)
    {
      const fs::path candidate = current / kExternalPluginsCollectionRelPath;
      if (fs::exists(candidate))
        return candidate;

      const fs::path parent = current.parent_path();
      if (parent == current)
        break;
      current = parent;
    }
    return std::nullopt;
  }

  nlohmann::json LoadExternalPluginCollection(const fs::path& path)
  {
    std::ifstream input(path);
    if (!input)
      return nlohmann::json::array();

    nlohmann::json parsed;
    try
    {
      input >> parsed;
    }
    catch (...)
    {
      return nlohmann::json::array();
    }

    const auto pluginsIt = parsed.find("plugins");
    if (pluginsIt == parsed.end() || !pluginsIt->is_array())
      return nlohmann::json::array();

    nlohmann::json out = nlohmann::json::array();
    for (const auto& row : *pluginsIt)
    {
      if (!row.is_object())
        continue;
      const auto idIt = row.find("pluginId");
      const auto labelIt = row.find("pluginLabel");
      if (idIt == row.end() || labelIt == row.end() || !idIt->is_string() || !labelIt->is_string())
        continue;

      nlohmann::json plugin;
      plugin["pluginId"] = *idIt;
      plugin["pluginLabel"] = *labelIt;
      const auto pathIt = row.find("pluginPath");
      if (pathIt != row.end() && pathIt->is_string())
        plugin["pluginPath"] = *pathIt;
      out.push_back(std::move(plugin));
    }
    return out;
  }

  std::vector<ExternalPluginVariant> ParseExternalPluginVariants(const nlohmann::json& pluginsJson)
  {
    std::vector<ExternalPluginVariant> out;
    if (!pluginsJson.is_array())
      return out;

    for (const auto& row : pluginsJson)
    {
      if (!row.is_object())
        continue;

      const auto pluginIdIt = row.find("pluginId");
      const auto labelIt = row.find("pluginLabel");
      const auto pathIt = row.find("pluginPath");
      if (pluginIdIt == row.end() || labelIt == row.end() || pathIt == row.end()
          || !pluginIdIt->is_string() || !labelIt->is_string() || !pathIt->is_string())
      {
        continue;
      }

      ExternalPluginVariant variant;
      variant.pluginId = pluginIdIt->get<std::string>();
      variant.label = labelIt->get<std::string>();
      variant.pluginPath = pathIt->get<std::string>();

      const auto stateKeyIt = row.find("stateConfigKey");
      if (stateKeyIt != row.end() && stateKeyIt->is_string() && !stateKeyIt->get<std::string>().empty())
        variant.stateConfigKey = stateKeyIt->get<std::string>();

      const auto stateMapIt = row.find("stateBySemitone");
      if (stateMapIt != row.end() && stateMapIt->is_object())
      {
        for (auto it = stateMapIt->begin(); it != stateMapIt->end(); ++it)
        {
          if (!it.value().is_string())
            continue;
          try
          {
            const int semitone = std::stoi(it.key());
            variant.stateBySemitone[semitone] = it.value().get<std::string>();
          }
          catch (...)
          {
          }
        }
      }

      out.push_back(std::move(variant));
    }

    return out;
  }
} // namespace

int main(int argc, char** argv)
{
  bool renderAllDemoAudio = false;
  std::vector<std::string> positionalArgs;
  positionalArgs.reserve(static_cast<size_t>(std::max(0, argc - 1)));

  for (int i = 1; i < argc; ++i)
  {
    const std::string arg = argv[i];
    if (arg == "--all-demo-audio")
    {
      renderAllDemoAudio = true;
      continue;
    }
    if (arg == "-h" || arg == "--help")
    {
      std::cout << "Usage: " << argv[0]
                << " [--all-demo-audio] [outputRoot] [snapshotLabel]\n"
                << "  --all-demo-audio  render all demo inputs (default renders first riff only)\n"
                << "  outputRoot        default: transpose-benchmark-out\n"
                << "  snapshotLabel     default: snapshot-<UTC timestamp>\n";
      return 0;
    }
    if (!arg.empty() && arg[0] == '-')
    {
      std::cerr << "ERROR: unknown option: " << arg << '\n';
      return 1;
    }
    positionalArgs.push_back(arg);
  }

  if (positionalArgs.size() > 2)
  {
    std::cerr << "ERROR: too many positional arguments\n";
    return 1;
  }

  const fs::path outputRoot = positionalArgs.size() > 0
    ? fs::path(positionalArgs[0])
    : fs::path("transpose-benchmark-out");
  const std::string snapshot = positionalArgs.size() > 1
    ? positionalArgs[1]
    : DefaultSnapshotLabel();
  const fs::path snapshotDir = outputRoot / snapshot;

  std::error_code ec;
  fs::create_directories(snapshotDir, ec);
  if (ec)
  {
    std::cerr << "ERROR: cannot create output directory " << snapshotDir << ": " << ec.message() << '\n';
    return 1;
  }

  guitarfx::RegisterAllEffects();
  auto& registry = guitarfx::EffectRegistry::Instance();

  nlohmann::json report;
  report["snapshot"] = snapshot;
  report["blockSize"] = kBlockSize;
  report["maxRenderSeconds"] = kMaxRenderSeconds;
  report["latencyMeasurementResolutionFrames"] = kEnvelopeDecimation;
  {
    const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm utc{};
#if defined(_WIN32)
    gmtime_s(&utc, &now);
#else
    gmtime_r(&now, &utc);
#endif
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &utc);
    report["generatedAt"] = buffer;
  }
  report["references"] = nlohmann::json::array();
  report["passes"] = nlohmann::json::array();

  if (const auto collectionPath = FindExternalPluginCollectionPath())
  {
    report["externalPlugins"] = LoadExternalPluginCollection(*collectionPath);
    report["externalPluginsSource"] = collectionPath->generic_string();
  }
  else
  {
    report["externalPlugins"] = nlohmann::json::array();
    std::cerr << "WARN: external plugin collection not found at tools/transpose-benchmark/external-plugins.json\n";
  }

  const std::vector<ExternalPluginVariant> externalVariants =
    ParseExternalPluginVariants(report["externalPlugins"]);

  const std::string pluginHostAlias = [&]() -> std::string
  {
    const std::string resolved = registry.Resolve("plugin_host");
    if (!resolved.empty())
      return "plugin_host";
    const std::string resolvedJuce = registry.Resolve("juce_plugin_host");
    if (!resolvedJuce.empty())
      return "juce_plugin_host";
    return {};
  }();

  if (!externalVariants.empty() && pluginHostAlias.empty())
  {
    std::cerr << "WARN: external plugin variants are configured but plugin host effect is not registered; "
                 "skipping inline external renders\n";
  }

  const fs::path demoDir(GUITARFX_DEMO_AUDIO_DIR);
  int failures = 0;

  std::vector<std::string> demoSamplesToRender;
  if (renderAllDemoAudio)
  {
    demoSamplesToRender = kDemoSamples;
  }
  else if (!kDemoSamples.empty())
  {
    demoSamplesToRender.push_back(kDemoSamples.front());
  }

  if (demoSamplesToRender.empty())
  {
    std::cerr << "ERROR: no demo samples configured\n";
    return 1;
  }

  for (const auto& sampleName : demoSamplesToRender)
  {
    const fs::path samplePath = demoDir / sampleName;
    const auto audio = LoadDemoSample(samplePath);
    if (!audio)
    {
      std::cerr << "WARN: skipping demo sample (missing or undecodable): " << samplePath << '\n';
      continue;
    }

    const std::string sampleStem = SanitizeForFilename(fs::path(sampleName).stem().string());

    // Dry reference for the report.
    const std::string referenceFile = "reference_" + sampleStem + ".wav";
    if (!WriteWav16(snapshotDir / referenceFile, *audio))
    {
      std::cerr << "ERROR: cannot write reference wav for " << sampleName << '\n';
      ++failures;
      continue;
    }
    nlohmann::json reference;
    reference["sample"] = sampleName;
    reference["wav"] = referenceFile;
    reference["sampleRate"] = audio->sampleRate;
    reference["frames"] = audio->frames();
    report["references"].push_back(reference);

    std::cout << "Sample: " << sampleName << " (" << audio->sampleRate << " Hz, "
              << audio->frames() << " frames)\n";

    for (const auto& variant : kVariants)
    {
      const auto info = registry.GetTypeInfo(registry.Resolve(variant.alias));
      double minSemitones = -12.0;
      double maxSemitones = 12.0;
      if (info)
      {
        for (const auto& param : info->parameters)
        {
          if (param.id == "semitones")
          {
            minSemitones = param.minValue;
            maxSemitones = param.maxValue;
          }
        }
      }

      for (const int semitones : kSemitoneSettings)
      {
        if (semitones < minSemitones || semitones > maxSemitones)
          continue;

        std::cout << "  " << variant.label << " @ " << semitones << " st ... " << std::flush;
        const auto pass = RunPass(variant, semitones, *audio);
        if (!pass)
        {
          ++failures;
          continue;
        }

        const std::string wavFile = SanitizeForFilename(variant.label) + "_"
          + (semitones < 0 ? "m" : "p") + std::to_string(std::abs(semitones)) + "st_"
          + sampleStem + ".wav";
        if (!WriteWav16(snapshotDir / wavFile, pass->render))
        {
          std::cerr << "ERROR: cannot write " << wavFile << '\n';
          ++failures;
          continue;
        }

        nlohmann::json entry = pass->stats;
        entry["effect"] = variant.alias;
        entry["effectLabel"] = variant.label;
        entry["sample"] = sampleName;
        entry["semitones"] = semitones;
        entry["sampleRate"] = audio->sampleRate;
        entry["wav"] = wavFile;
        report["passes"].push_back(entry);

        std::cout << "latency " << pass->stats["reportedLatencySamples"].get<int>()
                  << " rep / " << pass->stats["measuredLatencySamples"].get<int>()
                  << " meas samples, rtf " << pass->stats["realtimeFactor"].get<double>() << '\n';
      }
    }

    if (!pluginHostAlias.empty())
    {
      for (const auto& plugin : externalVariants)
      {
        std::vector<int> semitonesToRun;
        if (!plugin.stateBySemitone.empty())
        {
          for (const int semitone : kSemitoneSettings)
          {
            if (plugin.stateBySemitone.contains(semitone))
              semitonesToRun.push_back(semitone);
          }
        }
        else
        {
          semitonesToRun.push_back(0);
        }

        if (semitonesToRun.empty())
        {
          std::cerr << "  WARN: skipping " << plugin.label
                    << " (no usable semitone states in stateBySemitone)\n";
          continue;
        }

        for (const int semitones : semitonesToRun)
        {
          std::cout << "  " << plugin.label << " @ " << semitones << " st ... " << std::flush;

          const std::optional<PassResult> pass = RunConfiguredPass(pluginHostAlias,
                                                                    plugin.label,
                                                                    *audio,
                                                                    [&](guitarfx::EffectProcessor& effect)
                                                                    {
                                                                      effect.SetParam("mix", 1.0);
                                                                      effect.SetConfig("pluginPath", plugin.pluginPath);
                                                                      if (const auto stateIt = plugin.stateBySemitone.find(semitones);
                                                                          stateIt != plugin.stateBySemitone.end())
                                                                      {
                                                                        effect.SetConfig(plugin.stateConfigKey, stateIt->second);
                                                                      }
                                                                    });
          if (!pass)
          {
            ++failures;
            continue;
          }

          const std::string wavFile = SanitizeForFilename(plugin.label) + "_"
            + (semitones < 0 ? "m" : "p") + std::to_string(std::abs(semitones)) + "st_"
            + sampleStem + ".wav";
          if (!WriteWav16(snapshotDir / wavFile, pass->render))
          {
            std::cerr << "ERROR: cannot write " << wavFile << '\n';
            ++failures;
            continue;
          }

          nlohmann::json entry = pass->stats;
          entry["effect"] = plugin.pluginId;
          entry["effectLabel"] = plugin.label;
          entry["sourcePluginPath"] = plugin.pluginPath;
          entry["sample"] = sampleName;
          entry["semitones"] = semitones;
          entry["sampleRate"] = audio->sampleRate;
          entry["wav"] = wavFile;
          report["passes"].push_back(entry);

          std::cout << "latency " << pass->stats["reportedLatencySamples"].get<int>()
                    << " rep / " << pass->stats["measuredLatencySamples"].get<int>()
                    << " meas samples, rtf " << pass->stats["realtimeFactor"].get<double>() << '\n';
        }
      }
    }
  }

  if (report["passes"].empty())
  {
    std::cerr << "ERROR: no benchmark passes were produced\n";
    return 1;
  }

  const fs::path resultsPath = snapshotDir / "results.json";
  std::ofstream results(resultsPath);
  if (!results)
  {
    std::cerr << "ERROR: cannot write " << resultsPath << '\n';
    return 1;
  }
  results << report.dump(2) << '\n';

  std::cout << "\nWrote " << report["passes"].size() << " passes to " << snapshotDir << '\n';
  std::cout << "Generate the HTML report with:\n"
            << "  python tools/transpose-benchmark/generate_report.py " << outputRoot << '\n';
  return failures == 0 ? 0 : 1;
}
