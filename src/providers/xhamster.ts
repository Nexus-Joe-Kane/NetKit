import { createUnavailableProvider } from "./stub";

export const xhamsterProvider = createUnavailableProvider({
  id: "xhamster",
  name: "xHamster",
  description: "Awaiting an authorised, stable provider integration.",
  reason:
    "no supported public or delegated API was verified; browser stealth and anti-bot bypasses are intentionally excluded",
  sortOrder: 10,
});
