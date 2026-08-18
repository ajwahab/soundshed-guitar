#include "resources/ResourceLibrary.h"
#include "util/PathEncoding.h"
#include "presets/PresetTypes.h"

#include <nlohmann/json.hpp>
#include <fstream>

namespace guitarfx
{
  namespace
  {
    bool IsRelativeOutside(const std::filesystem::path& relativePath)
    {
      if (relativePath.empty()) return false;
      const auto it = relativePath.begin();
      return it != relativePath.end() && *it == "..";
    }
  }

  ResourceLibrary::ResourceLibrary() = default;
  ResourceLibrary::~ResourceLibrary() = default;

  std::string ResourceLibrary::MakeKey(const std::string& type, const std::string& id)
  {
    return type + ":" + id;
  }

  void ResourceLibrary::AddResource(const LibraryResource& resource)
  {
    const auto key = MakeKey(resource.type, resource.id);
    mResources[key] = resource;
  }

  void ResourceLibrary::UpdateResource(const std::string& type, const std::string& id, const LibraryResource& updated)
  {
    const auto key = MakeKey(type, id);
    if (mResources.count(key))
    {
      mResources[key] = updated;
    }
  }

  void ResourceLibrary::RemoveResource(const std::string& type, const std::string& id)
  {
    const auto key = MakeKey(type, id);
    mResources.erase(key);
  }

  void ResourceLibrary::Clear()
  {
    mResources.clear();
  }

  std::optional<LibraryResource> ResourceLibrary::LookupResource(const std::string& type, const std::string& id) const
  {
    const auto key = MakeKey(type, id);
    auto it = mResources.find(key);
    if (it != mResources.end())
    {
      return it->second;
    }

    if (id.find("__") != std::string::npos)
    {
      const auto lastDoubleUnderscore = id.rfind("__");
      if (lastDoubleUnderscore != std::string::npos && lastDoubleUnderscore + 2 < id.length())
      {
        const auto suffix = id.substr(lastDoubleUnderscore + 2);
        const auto fallbackKey = MakeKey(type, suffix);
        auto fallbackIt = mResources.find(fallbackKey);
        if (fallbackIt != mResources.end())
        {
          return fallbackIt->second;
        }

        // Search for any other resource whose ID ends with "__" + suffix or is suffix
        const std::string marker = "__" + suffix;
        for (const auto& [resKey, resource] : mResources)
        {
          if (resource.type == type)
          {
            if (resource.id == suffix || 
                (resource.id.length() >= marker.length() && 
                 resource.id.compare(resource.id.length() - marker.length(), marker.length(), marker) == 0))
            {
              return resource;
            }
          }
        }
      }
    }
    else
    {
      // The search ID is a clean suffix, but maybe the library has it with a prefix
      const std::string marker = "__" + id;
      for (const auto& [resKey, resource] : mResources)
      {
        if (resource.type == type)
        {
          if (resource.id.length() >= marker.length() && 
              resource.id.compare(resource.id.length() - marker.length(), marker.length(), marker) == 0)
          {
            return resource;
          }
        }
      }
    }

    return std::nullopt;
  }

  std::vector<LibraryResource> ResourceLibrary::GetResourcesByType(const std::string& type) const
  {
    std::vector<LibraryResource> result;
    for (const auto& [key, resource] : mResources)
    {
      if (resource.type == type)
      {
        result.push_back(resource);
      }
    }
    return result;
  }

  std::vector<LibraryResource> ResourceLibrary::GetResourcesByCategory(const std::string& type, const std::string& category) const
  {
    std::vector<LibraryResource> result;
    for (const auto& [key, resource] : mResources)
    {
      if (resource.type == type && resource.category == category)
      {
        result.push_back(resource);
      }
    }
    return result;
  }

  std::vector<LibraryResource> ResourceLibrary::GetAllResources() const
  {
    std::vector<LibraryResource> result;
    result.reserve(mResources.size());
    for (const auto& [key, resource] : mResources)
    {
      result.push_back(resource);
    }
    return result;
  }

  std::vector<std::pair<std::string, std::string>> ResourceLibrary::GetResourcePathIndex() const
  {
    std::vector<std::pair<std::string, std::string>> result;
    result.reserve(mResources.size());
    for (const auto& [key, resource] : mResources)
    {
      if (resource.filePath.empty())
        continue;
      result.emplace_back(util::PathToUtf8(resource.filePath), resource.id);
    }
    return result;
  }

  bool ResourceLibrary::HasResource(const std::string& type, const std::string& id) const
  {
    return LookupResource(type, id).has_value();
  }

  std::optional<std::filesystem::path> ResourceLibrary::ResolveResource(const ResourceRef& ref) const
  {
    // Priority: Library > FilePath
    if (ref.IsLibraryRef())
    {
      auto resource = LookupResource(ref.resourceType, ref.resourceId);
      if (resource && std::filesystem::exists(resource->filePath))
      {
        return resource->filePath;
      }

      // If the matched resource file doesn't exist, search the library for any fallback item whose file does exist
      const std::string& id = ref.resourceId;
      std::string suffix = id;
      if (id.find("__") != std::string::npos)
      {
        suffix = id.substr(id.rfind("__") + 2);
      }

      for (const auto& [resKey, res] : mResources)
      {
        if (res.type == ref.resourceType)
        {
          bool isMatch = (res.id == suffix) ||
                         (res.id.length() >= suffix.length() + 2 &&
                          res.id.compare(res.id.length() - suffix.length(), suffix.length(), suffix) == 0);

          if (!isMatch)
          {
            auto origIdIt = res.metadata.find("originalId");
            if (origIdIt != res.metadata.end() && origIdIt->second == suffix)
            {
              isMatch = true;
            }
          }

          if (!isMatch && resource && !resource->hash.empty() && !res.hash.empty() && res.hash == resource->hash)
          {
            isMatch = true;
          }

          if (isMatch && std::filesystem::exists(res.filePath))
          {
            return res.filePath;
          }
        }
      }

      // Last resort: if we have a resolved entry but its file is missing, return its path anyway and let loader fail
      if (resource)
      {
        return resource->filePath;
      }
    }

    if (ref.IsFilePath())
    {
      if (std::filesystem::exists(ref.filePath))
      {
        return ref.filePath;
      }
    }

    // Embedded resources are handled separately by the preset loader
    return std::nullopt;
  }

  void ResourceLibrary::LoadFromDirectory(const std::filesystem::path& directory)
  {
    if (!std::filesystem::exists(directory))
    {
      return;
    }

    // Look for library.json in the directory
    auto libraryFile = directory / "library.json";
    if (std::filesystem::exists(libraryFile))
    {
      LoadFromFile(libraryFile);
    }
  }

  void ResourceLibrary::SaveToFile(const std::filesystem::path& path) const
  {
    nlohmann::json json = nlohmann::json::array();
    const auto indexDir = path.parent_path();
    const auto resourcesRoot = indexDir.parent_path();

    std::error_code dirEc;
    std::filesystem::create_directories(indexDir, dirEc);

    for (const auto& [key, resource] : mResources)
    {
      nlohmann::json item;
      item["type"] = resource.type;
      item["id"] = resource.id;
      item["name"] = resource.name;
      item["category"] = resource.category;
      item["description"] = resource.description;
      if (!resource.filePath.empty())
      {
        std::error_code relEc;
        const auto relativeToResources = std::filesystem::relative(resource.filePath, resourcesRoot, relEc);
        if (!relEc && !relativeToResources.empty() && relativeToResources != std::filesystem::path(".")
            && !IsRelativeOutside(relativeToResources))
        {
          item["filePath"] = util::PathToUtf8(relativeToResources);
        }
        else
        {
          item["filePath"] = util::PathToUtf8(resource.filePath);
        }
      }
      else
      {
        item["filePath"] = "";
      }
      item["hash"] = resource.hash;
      item["tags"] = resource.tags;
      if (!resource.metadata.empty())
      {
        item["metadata"] = resource.metadata;
      }
      json.push_back(item);
    }

    std::ofstream file(path);
    if (file.is_open())
    {
      file << json.dump(2);
    }
  }

  void ResourceLibrary::LoadFromFile(const std::filesystem::path& path)
  {
    std::ifstream file(path);
    if (!file.is_open())
    {
      return;
    }

    try
    {
      nlohmann::json json;
      file >> json;

      if (!json.is_array())
      {
        return;
      }

      for (const auto& item : json)
      {
        LibraryResource resource;
        resource.type = item.value("type", "");
        resource.id = item.value("id", "");
        resource.name = item.value("name", "");
        resource.category = item.value("category", "");
        resource.description = item.value("description", "");
        {
          const std::string rawPath = item.value("filePath", "");
          if (!rawPath.empty())
          {
            std::filesystem::path resolvedPath(rawPath);
            if (resolvedPath.is_relative())
            {
              const auto indexRelativePath = path.parent_path() / resolvedPath;
              const auto resourcesRelativePath = path.parent_path().parent_path() / resolvedPath;

              std::error_code indexExistsEc;
              if (std::filesystem::exists(indexRelativePath, indexExistsEc))
              {
                resolvedPath = indexRelativePath;
              }
              else
              {
                std::error_code resourcesExistsEc;
                if (std::filesystem::exists(resourcesRelativePath, resourcesExistsEc))
                  resolvedPath = resourcesRelativePath;
                else if (!IsRelativeOutside(resolvedPath))
                  resolvedPath = resourcesRelativePath;
                else
                  resolvedPath = indexRelativePath;
              }
            }
            resource.filePath = resolvedPath;
          }
        }
        resource.hash = item.value("hash", "");

        if (item.contains("tags") && item["tags"].is_array())
        {
          for (const auto& tag : item["tags"])
          {
            resource.tags.push_back(tag.get<std::string>());
          }
        }

        if (item.contains("metadata") && item["metadata"].is_object())
        {
          for (const auto& entry : item["metadata"].items())
          {
            const auto& value = entry.value();
            if (value.is_string())
            {
              resource.metadata[entry.key()] = value.get<std::string>();
            }
            else if (value.is_number())
            {
              resource.metadata[entry.key()] = value.dump();
            }
            else if (value.is_boolean())
            {
              resource.metadata[entry.key()] = value.get<bool>() ? "true" : "false";
            }
          }
        }

        if (!resource.type.empty() && !resource.id.empty())
        {
          AddResource(resource);
        }
      }
    }
    catch (const std::exception&)
    {
      // Invalid JSON, ignore
    }
  }

} // namespace guitarfx
