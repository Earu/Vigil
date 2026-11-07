#ifndef VIGIL_TPM_PARSE_H_
#define VIGIL_TPM_PARSE_H_

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace vigil_tpm {

constexpr size_t kMaxPinLength = 32;
constexpr size_t kMaxSecretLength = 128;

inline void Scrub(std::vector<uint8_t>& buffer) {
    volatile uint8_t* p = buffer.data();
    for (size_t i = 0; i < buffer.size(); ++i) p[i] = 0;
    buffer.clear();
}

inline void Scrub(std::string& text) {
    volatile char* p = text.empty() ? nullptr : &text[0];
    for (size_t i = 0; i < text.size(); ++i) p[i] = 0;
    text.clear();
}

inline bool IsPin(const std::string& pin) {
    if (pin.empty() || pin.size() > kMaxPinLength) return false;
    for (char c : pin) {
        if (c < '0' || c > '9') return false;
    }
    return true;
}

inline bool IsSecret(const std::vector<uint8_t>& secret) {
    return !secret.empty() && secret.size() <= kMaxSecretLength;
}

struct Span {
    size_t offset = 0;
    size_t size = 0;
};

inline bool ReadSized(const uint8_t* data, size_t size, size_t offset, size_t maxBody, Span* span) {
    if (size - offset < 2) return false;
    const size_t body = (static_cast<size_t>(data[offset]) << 8) | data[offset + 1];
    if (body == 0 || body > maxBody || size - offset - 2 < body) return false;
    span->offset = offset;
    span->size = 2 + body;
    return true;
}

inline bool SplitSealed(const uint8_t* data, size_t size, size_t maxPrivate, size_t maxPublic,
                        Span* privatePart, Span* publicPart) {
    if (data == nullptr || size < 4) return false;
    if (!ReadSized(data, size, 0, maxPrivate, privatePart)) return false;
    if (!ReadSized(data, size, privatePart->size, maxPublic, publicPart)) return false;
    return publicPart->offset + publicPart->size == size;
}

}  // namespace vigil_tpm

#endif
