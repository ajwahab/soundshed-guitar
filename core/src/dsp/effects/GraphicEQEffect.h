#pragma once

#include "dsp/EffectGuids.h"
#include "dsp/EffectProcessor.h"
#include "dsp/EffectRegistry.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <string>

namespace guitarfx
{
  class GraphicEQEffect : public EffectProcessor
  {
  public:
    static constexpr int kMinBands = 5;
    static constexpr int kMaxBands = 10;
    static constexpr std::array<double, kMaxBands> kDefaultFrequencies = {
      31.25, 62.5, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0};

    void Prepare(double sampleRate, int maxBlockSize) override
    {
      if (!ValidatePrepare(sampleRate, maxBlockSize))
        return;
      mSampleRate = sampleRate;
      UpdateCoefficients();
      Reset();
    }

    void Reset() override
    {
      for (auto& band : mBands)
      {
        band.x1L = band.x2L = band.y1L = band.y2L = 0.0f;
        band.x1R = band.x2R = band.y1R = band.y2R = 0.0f;
      }
    }

    void Process(float** inputs, float** outputs, int numSamples) override
    {
      for (int sampleIndex = 0; sampleIndex < numSamples; ++sampleIndex)
      {
        float left = inputs[0] ? inputs[0][sampleIndex] : 0.0f;
        float right = inputs[1] ? inputs[1][sampleIndex] : 0.0f;

        for (int bandIndex = 0; bandIndex < mBandCount; ++bandIndex)
        {
          auto& band = mBands[bandIndex];
          if (!band.enabled)
            continue;
          left = ProcessSample(left, band.b0, band.b1, band.b2, band.a1, band.a2,
                               band.x1L, band.x2L, band.y1L, band.y2L);
          right = ProcessSample(right, band.b0, band.b1, band.b2, band.a1, band.a2,
                                band.x1R, band.x2R, band.y1R, band.y2R);
        }

        if (outputs[0])
          outputs[0][sampleIndex] = left;
        if (outputs[1])
          outputs[1][sampleIndex] = right;
      }
    }

    void SetParam(const std::string& key, double value) override
    {
      if (key == "bandCount")
      {
        mBandCount = static_cast<int>(std::clamp(std::round(FiniteOr(value, 10.0)), static_cast<double>(kMinBands), static_cast<double>(kMaxBands)));
      }
      else if (key == "preset")
      {
        mPreset = static_cast<int>(std::clamp(std::round(FiniteOr(value, 0.0)), 0.0, 2.0));
      }
      else
      {
        const int bandIndex = ParseBandIndex(key);
        if (bandIndex < 0)
          return;

        auto& band = mBands[bandIndex];
        const std::string suffix = key.substr(key.find_first_not_of("0123456789", 4));
        if (suffix == "Enabled")
          band.enabled = value >= 0.5;
        else if (suffix == "Gain")
          band.gainDb = ClampFinite(value, -18.0, 18.0, 0.0);
        else if (suffix == "Freq")
          band.frequencyHz = ClampFrequencyForBand(bandIndex, value);
        else
          return;
      }

      UpdateCoefficients();
    }

    [[nodiscard]] double GetParam(const std::string& key) const override
    {
      if (key == "bandCount")
        return mBandCount;
      if (key == "preset")
        return mPreset;

      const int bandIndex = ParseBandIndex(key);
      if (bandIndex < 0)
        return 0.0;

      const auto& band = mBands[bandIndex];
      const std::string suffix = key.substr(key.find_first_not_of("0123456789", 4));
      if (suffix == "Enabled")
        return band.enabled ? 1.0 : 0.0;
      if (suffix == "Gain")
        return band.gainDb;
      if (suffix == "Freq")
        return band.frequencyHz;
      return 0.0;
    }

    void SetConfig(const std::string&, const std::string&) override {}
    [[nodiscard]] std::string GetType() const override { return "eq_graphic"; }
    [[nodiscard]] std::string GetCategory() const override { return "eq"; }

  private:
    struct Band
    {
      bool enabled = true;
      double gainDb = 0.0;
      double frequencyHz = 1000.0;
      float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f, a1 = 0.0f, a2 = 0.0f;
      float x1L = 0.0f, x2L = 0.0f, y1L = 0.0f, y2L = 0.0f;
      float x1R = 0.0f, x2R = 0.0f, y1R = 0.0f, y2R = 0.0f;
    };

    static constexpr double kQ = 1.4142135623730951;

    static double FiniteOr(double value, double fallback)
    {
      return std::isfinite(value) ? value : fallback;
    }

    static double ClampFinite(double value, double minimum, double maximum, double fallback)
    {
      return std::clamp(FiniteOr(value, fallback), minimum, maximum);
    }

    [[nodiscard]] double MaxFrequency() const
    {
      return std::max(20.0, std::min(20000.0, mSampleRate * 0.49));
    }

    [[nodiscard]] double ClampFrequencyForBand(int bandIndex, double value) const
    {
      const double minimum = bandIndex > 0 ? mBands[bandIndex - 1].frequencyHz + 1.0 : 20.0;
      const double maximum = bandIndex < kMaxBands - 1 ? mBands[bandIndex + 1].frequencyHz - 1.0 : MaxFrequency();
      if (minimum > maximum)
        return ClampFinite(value, 20.0, MaxFrequency(), kDefaultFrequencies[bandIndex]);
      return ClampFinite(value, minimum, maximum, kDefaultFrequencies[bandIndex]);
    }

    static int ParseBandIndex(const std::string& key)
    {
      if (key.rfind("band", 0) != 0 || key.size() < 6)
        return -1;

      std::size_t cursor = 4;
      int oneBasedIndex = 0;
      while (cursor < key.size() && key[cursor] >= '0' && key[cursor] <= '9')
      {
        oneBasedIndex = oneBasedIndex * 10 + (key[cursor] - '0');
        ++cursor;
      }
      return cursor == 4 || oneBasedIndex < 1 || oneBasedIndex > kMaxBands ? -1 : oneBasedIndex - 1;
    }

    static float ProcessSample(float input, float b0, float b1, float b2, float a1, float a2,
                               float& x1, float& x2, float& y1, float& y2)
    {
      const float sanitizedInput = std::isfinite(input) ? input : 0.0f;
      float output = b0 * sanitizedInput + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      if (!std::isfinite(output))
      {
        x1 = x2 = y1 = y2 = 0.0f;
        return sanitizedInput;
      }
      x2 = x1;
      x1 = sanitizedInput;
      y2 = y1;
      y1 = output;
      return output;
    }

    void UpdateCoefficients()
    {
      const double maxFrequency = MaxFrequency();
      for (int index = 0; index < kMaxBands; ++index)
      {
        auto& band = mBands[index];
        band.gainDb = ClampFinite(band.gainDb, -18.0, 18.0, 0.0);
        band.frequencyHz = ClampFinite(band.frequencyHz, 20.0, maxFrequency, kDefaultFrequencies[index]);

        if (std::abs(band.gainDb) < 0.001)
        {
          band.b0 = 1.0f;
          band.b1 = band.b2 = band.a1 = band.a2 = 0.0f;
          continue;
        }

        const double amplitude = std::pow(10.0, band.gainDb / 40.0);
        const double w0 = 2.0 * 3.14159265358979323846 * band.frequencyHz / mSampleRate;
        const double alpha = std::sin(w0) / (2.0 * kQ);
        const double a0 = 1.0 + alpha / amplitude;
        if (!std::isfinite(a0) || std::abs(a0) < 1.0e-9)
        {
          band.b0 = 1.0f;
          band.b1 = band.b2 = band.a1 = band.a2 = 0.0f;
          continue;
        }

        band.b0 = static_cast<float>((1.0 + alpha * amplitude) / a0);
        band.b1 = static_cast<float>(-2.0 * std::cos(w0) / a0);
        band.b2 = static_cast<float>((1.0 - alpha * amplitude) / a0);
        band.a1 = band.b1;
        band.a2 = static_cast<float>((1.0 - alpha / amplitude) / a0);
      }
    }

    double mSampleRate = 48000.0;
    int mBandCount = kMaxBands;
    int mPreset = 0;
    std::array<Band, kMaxBands> mBands = [] {
      std::array<Band, kMaxBands> bands{};
      for (int index = 0; index < kMaxBands; ++index)
        bands[index].frequencyHz = kDefaultFrequencies[index];
      return bands;
    }();
  };

  inline void RegisterGraphicEQEffect()
  {
    EffectTypeInfo info;
    info.type = EffectGuids::kEqGraphic;
    info.aliases = {"eq_graphic"};
    info.displayName = "Graphic Equalizer";
    info.category = "eq";
    info.description = "5 to 10 band graphic equalizer with Bass and Guitar profiles";
    info.requiresResource = false;
    info.parameters = {
      {"preset", "Profile", 0.0, 0.0, 2.0, "enum", "Profile", false, 1.0, {"Flat", "Bass", "Guitar"}},
      {"bandCount", "Bands", 10.0, 5.0, 10.0, "amount", "Profile", false, 1.0, {}}};
    for (int index = 1; index <= GraphicEQEffect::kMaxBands; ++index)
    {
      const std::string prefix = "band" + std::to_string(index);
      const std::string group = "Band " + std::to_string(index);
      info.parameters.push_back({prefix + "Enabled", "Enabled", 1.0, 0.0, 1.0, "toggle", group, false, 1.0, {}});
      info.parameters.push_back({prefix + "Gain", "Gain", 0.0, -18.0, 18.0, "dB", group, false, 0.1, {}});
      info.parameters.push_back({prefix + "Freq", "Frequency", GraphicEQEffect::kDefaultFrequencies[index - 1], 20.0, 20000.0, "Hz", group, false, 1.0, {}});
    }
    EffectRegistry::Instance().Register(info.type, info, [] { return std::make_unique<GraphicEQEffect>(); });
  }
} // namespace guitarfx
