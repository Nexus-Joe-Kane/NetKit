import { createUnavailableProvider } from "./stub";

export const fpoProvider = createUnavailableProvider({
  id: "fpo",
  name: "fpo.xxx",
  description: "Awaiting an authorised, stable provider integration.",
  reason: "no documented public API, OAuth flow, or provider-issued integration was verified",
  sortOrder: 50,
});
