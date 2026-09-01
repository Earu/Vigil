{
  "targets": [
    {
      "target_name": "vigil_touchid",
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/touchid_mac.mm"],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"]
          },
          "link_settings": {
            "libraries": [
              "-framework Security",
              "-framework LocalAuthentication",
              "-framework Foundation",
              "-framework CoreFoundation"
            ]
          }
        }, {
          "sources": ["src/touchid_stub.cc"]
        }]
      ]
    }
  ]
}
