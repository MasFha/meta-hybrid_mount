import { createRoot, createSignal } from "solid-js";
import { ENABLE_KASUMI } from "./constants_gen";

const createFeatures = () => {
  const [kasumiEnabled, setKasumiEnabled] = createSignal(false);
  const [kasumiAvailable, setKasumiAvailable] = createSignal(false);

  return {
    get kasumiBuildEnabled() {
      return ENABLE_KASUMI;
    },
    get kasumiEnabled() {
      return ENABLE_KASUMI && kasumiEnabled();
    },
    get kasumiAvailable() {
      return ENABLE_KASUMI && kasumiAvailable();
    },
    setKasumiStatus(enabled: boolean, available: boolean) {
      if (!ENABLE_KASUMI) return;
      setKasumiEnabled(enabled);
      setKasumiAvailable(available);
    },
  };
};

export const features = createRoot(createFeatures);
