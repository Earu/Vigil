{
  "targets": [
    {
      "target_name": "vigil_tpm",
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/tpm_win.cc"],
          "defines": ["UNICODE", "_UNICODE"],
          "link_settings": {
            "libraries": ["ncrypt.lib", "bcrypt.lib"]
          }
        }],
        ["OS=='linux'", {
          "sources": ["src/tpm_linux.cc"],
          "cflags_cc": ["-std=c++17", "<!@(pkg-config --cflags tss2-esys tss2-mu tss2-tctildr)"],
          "libraries": ["<!@(pkg-config --libs tss2-esys tss2-mu tss2-tctildr)"]
        }],
        ["OS!='win' and OS!='linux'", {
          "sources": ["src/tpm_stub.cc"],
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"]
          }
        }]
      ]
    }
  ]
}
