import { headers } from "next/headers";

const MODERATOR_IP = "206.85.210.250";

function extractForwardedIp(forwardedFor: string | null) {
  if (!forwardedFor) {
    return null;
  }

  const first = forwardedFor.split(",")[0]?.trim();
  return first || null;
}

export async function getRequestIp() {
  const headerStore = await headers();

  return (
    extractForwardedIp(headerStore.get("x-forwarded-for")) ??
    headerStore.get("x-real-ip") ??
    headerStore.get("cf-connecting-ip") ??
    null
  );
}

export async function isModeratorRequest() {
  const ip = await getRequestIp();
  return ip === MODERATOR_IP;
}

export { MODERATOR_IP };
