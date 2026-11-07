#include "tpm_common.h"

namespace vigil_tpm {

namespace {
constexpr uint32_t kUnimplemented = 0xFFFFFFFF;
}

Outcome Seal(const Request&) { return Outcome{kUnimplemented, {}}; }
Outcome Unseal(const Request&) { return Outcome{kUnimplemented, {}}; }
Outcome Remove(const Request&) { return Outcome{kUnimplemented, {}}; }
uint32_t Probe() { return kUnimplemented; }
const char* PlatformName() { return "stub"; }

}  // namespace vigil_tpm
