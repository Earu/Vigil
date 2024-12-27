#pragma once

#include <windows.h>
#include <wincred.h>
#include <webauthn.h>

#ifdef __cplusplus
extern "C" {
#endif

// Function to check if Windows Hello is available
__declspec(dllexport) bool IsWindowsHelloAvailable();

// Function to authenticate using Windows Hello
__declspec(dllexport) bool AuthenticateWithWindowsHello(const wchar_t* message);

#ifdef __cplusplus
}
#endif