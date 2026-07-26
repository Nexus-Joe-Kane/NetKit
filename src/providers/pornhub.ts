import { createUnavailableProvider } from "./stub";

export const pornhubProvider = createUnavailableProvider({
  id: "pornhub",
  name: "Pornhub",
  description: "Awaiting a current, authorised provider agreement.",
  reason: "legacy Webmaster endpoints could not be verified as a current supported integration",
  sortOrder: 40,
});
