import { createUnavailableProvider } from "./stub";

export const faphouseProvider = createUnavailableProvider({
  id: "faphouse-ultra",
  name: "FapHouse Ultra",
  description: "Premium channel stub; subscription access is never bypassed.",
  reason: "no supported OAuth, API-token, or delegated premium integration was verified",
  premium: true,
  sortOrder: 20,
});
