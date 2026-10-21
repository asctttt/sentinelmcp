import type { FastifyBaseLogger } from 'fastify';
import { env } from './config/env.js';

export interface LicenseState {
  tier: 'community' | 'pro';
  valid: boolean;
}

const LICENSE_VERIFY_TIMEOUT_MS = 5_000;

// Stored in memory after boot — zero network calls during MCP requests
let currentLicense: LicenseState = { tier: 'community', valid: true };

export function getLicenseTier(): 'community' | 'pro' {
  return currentLicense.tier;
}

export async function verifyLicenseAtBoot(log: FastifyBaseLogger): Promise<LicenseState> {
  const licenseKey = env.SENTINEL_LICENSE_KEY;
  const orgId = env.POLAR_ORGANIZATION_ID;

  if (!licenseKey) {
    log.info({ tier: 'community' }, 'starting SentinelMCP in Community Edition (MIT)');
    currentLicense = { tier: 'community', valid: true };
    return currentLicense;
  }

  if (!orgId) {
    log.warn(
      { tier: 'community' },
      'SENTINEL_LICENSE_KEY is set, but POLAR_ORGANIZATION_ID is missing; falling back to Community Edition',
    );
    return currentLicense;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LICENSE_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.polar.sh/v1/customer-portal/license-keys/validate', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: licenseKey,
        organization_id: orgId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Polar license validation returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as { status?: string };

    if (data.status !== 'granted') {
      throw new Error(`License key status is "${data.status ?? 'unknown'}" (expected "granted")`);
    }

    log.info({ tier: 'pro' }, 'SentinelMCP Pro license verified');
    currentLicense = { tier: 'pro', valid: true };
    return currentLicense;
  } catch (err) {
    log.error({ err }, 'invalid or expired SENTINEL_LICENSE_KEY');
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}