#include "tpm_common.h"

namespace vigil_tpm {

Outcome Seal(const Request&) { return Outcome{kUnimplemented, {}}; }
Outcome Unseal(const Request&) { return Outcome{kUnimplemented, {}}; }
Outcome Remove(const Request&) { return Outcome{kUnimplemented, {}}; }
Outcome Lockout(const Request&) { return Outcome{kUnimplemented, {}}; }
Outcome SetLockout(const Request&) { return Outcome{kUnimplemented, {}}; }
uint32_t Probe() { return kUnimplemented; }
const char* PlatformName() { return "stub"; }

}  // namespace vigil_tpm
