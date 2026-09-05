import { useEffect, useState } from 'react';

// Whether a YubiKey is plugged in, as the main process sees it: a Yubico
// device on the HID bus, or a YubiKey reader on PC/SC (which is what catches
// a key with OTP and FIDO disabled). Polled, because neither bus hands the
// renderer a hotplug event; both checks are a few syscalls on a worker
// thread and never touch the card itself
const POLL_MS = 3000;

export function useYubiKeyPresence(): boolean {
    const [present, setPresent] = useState(false);
    useEffect(() => {
        let cancelled = false;
        const check = async () => {
            const offer = await window.electron?.yubikeyOathOffer?.();
            if (!cancelled) setPresent(!!offer);
        };
        void check();
        const timer = setInterval(check, POLL_MS);
        return () => { cancelled = true; clearInterval(timer); };
    }, []);
    return present;
}
