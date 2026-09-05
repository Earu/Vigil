{
  "targets": [
    {
      "target_name": "vigil_pcsc",
      "sources": ["src/pcsc_addon.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"]
          },
          "link_settings": {
            "libraries": ["-framework PCSC"]
          }
        }],
        ["OS=='win'", {
          "link_settings": {
            "libraries": ["winscard.lib"]
          }
        }],
        ["OS=='linux'", {
          "cflags_cc": ["-std=c++17", "<!@(pkg-config --cflags libpcsclite)"],
          "libraries": ["<!@(pkg-config --libs libpcsclite)"]
        }]
      ]
    }
  ]
}
