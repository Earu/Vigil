{
  "conditions": [
    ['OS=="win"', {
      "targets": [{
        "target_name": "windows_hello",
        "sources": [ "windows_hello.cpp" ],
        "include_dirs": [
          "<!@(node -p \"require('node-addon-api').include\")",
          "$(WindowsSdkDir)Include\\$(WindowsTargetPlatformVersion)\\um",
          "$(WindowsSdkDir)Include\\$(WindowsTargetPlatformVersion)\\shared",
          "$(WindowsSdkDir)Include\\$(WindowsTargetPlatformVersion)\\cppwinrt",
          "include"
        ],
        "dependencies": [
          "<!(node -p \"require('node-addon-api').gyp\")"
        ],
        "libraries": [
          "webauthn.lib",
          "crypt32.lib",
          "ncrypt.lib",
          "bcrypt.lib"
        ],
        "cflags!": [ "-fno-exceptions" ],
        "cflags_cc!": [ "-fno-exceptions" ],
        "defines": [
          "NAPI_DISABLE_CPP_EXCEPTIONS",
          "WIN32_LEAN_AND_MEAN",
          "NOMINMAX"
        ],
        "msvs_settings": {
          "VCCLCompilerTool": {
            "ExceptionHandling": 1,
            "AdditionalOptions": [
              "/std:c++17",
              "/permissive-",
              "/Zc:__cplusplus"
            ]
          },
          "VCLinkerTool": {
            "AdditionalLibraryDirectories": [
              "$(WindowsSdkDir)Lib\\$(WindowsTargetPlatformVersion)\\um\\x64"
            ]
          }
        }
      }]
    }, {
      "targets": []
    }]
  ]
}