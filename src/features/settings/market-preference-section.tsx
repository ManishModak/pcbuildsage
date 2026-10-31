"use client";

import { useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { fetchMarkets } from "@/lib/api-client";
import type { MarketMetadata } from "@/lib/config/deployment";
import {
  getMarketPreference,
  setMarketPreference,
  subscribeMarketPreference,
  type MarketPreference
} from "@/lib/market/client-market-store";
import { useOptionalApp } from "@/components/app/app-provider";
import { cn } from "@/components/ui/cn";
import { Select } from "@/components/ui/select";
import { Icon } from "@/components/ui/icon";
import { SettingsRow } from "./settings-rows";

export function MarketPreferenceSection({
  onChange,
  className,
  heading = true,
  initialMarkets
}: {
  onChange?: (pref: MarketPreference) => void;
  className?: string;
  /** Onboarding has its own step title, so it hides this one. */
  heading?: boolean;
  initialMarkets?: readonly MarketMetadata[];
}) {
  const [pref, setPref] = useState<MarketPreference>(() => getMarketPreference());
  const [markets, setMarkets] = useState<MarketMetadata[]>(() =>
    initialMarkets ? [...initialMarkets] : []
  );
  // Until the region list arrives, an empty list means "not loaded yet", not
  // "no regions on this server".
  const [loading, setLoading] = useState(!initialMarkets);

  const app = useOptionalApp();
  const updateAppConfig = app?.updateConfig ?? null;

  const callbacksRef = useRef({ onChange, updateAppConfig });
  useEffect(() => {
    callbacksRef.current = { onChange, updateAppConfig };
  });

  useEffect(() => {
    fetchMarkets()
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setMarkets(data);
          const currentPref = getMarketPreference();
          if (!data.some((m) => m.code === currentPref.countryCode)) {
            const first = data[0];
            const updated = setMarketPreference({
              countryCode: first.code,
              currencyCode: first.defaultCurrency,
              locale: first.locale
            });
            setPref(updated);
            if (callbacksRef.current.updateAppConfig) {
              callbacksRef.current.updateAppConfig({
                countryCode: updated.countryCode,
                currency: updated.currencyCode
              });
            }
            callbacksRef.current.onChange?.(updated);
          }
        } else {
          setMarkets([]);
        }
      })
      .catch(() => {
        setMarkets([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    return subscribeMarketPreference((next) => {
      setPref(next);
    });
  }, []);

  const activeMarket =
    markets.find((m) => m.code === pref.countryCode) ??
    markets[0];

  const handleCountryChange = (countryCode: string) => {
    const market = markets.find((m) => m.code === countryCode);
    if (!market) return;

    const currentCurrency = pref.currencyCode;
    const nextCurrency = market.supportedCurrencies.includes(currentCurrency)
      ? currentCurrency
      : market.defaultCurrency;
    const nextLocale = market.locale;

    const updated = setMarketPreference({
      countryCode: market.code,
      currencyCode: nextCurrency,
      locale: nextLocale
    });

    setPref(updated);
    if (callbacksRef.current.updateAppConfig) {
      callbacksRef.current.updateAppConfig({
        countryCode: updated.countryCode,
        currency: updated.currencyCode
      });
    }
    callbacksRef.current.onChange?.(updated);
  };

  const handleCurrencyChange = (currencyCode: string) => {
    const updated = setMarketPreference({ currencyCode });
    setPref(updated);
    if (callbacksRef.current.updateAppConfig) {
      callbacksRef.current.updateAppConfig({ currency: updated.currencyCode });
    }
    callbacksRef.current.onChange?.(updated);
  };

  const countryOptions = markets.map((m) => ({
    value: m.code,
    label: `${m.name} (${m.code})`
  }));

  const supportedCurrencies = activeMarket?.supportedCurrencies ?? [pref.currencyCode];
  const currencyOptions = supportedCurrencies.map((c) => ({
    value: c,
    label: c
  }));

  const summary =
    markets.length === 0 ? (
      <>
        Prices show in <span className="font-mono text-text">{pref.currencyCode}</span>. Saved in this browser.
      </>
    ) : (
      <>
        Showing {activeMarket?.name ?? pref.countryCode} prices in{" "}
        <span className="font-mono text-text">{pref.currencyCode}</span>. Saved in this browser.
      </>
    );

  return (
    <section className={cn("flex flex-col gap-3", className)} data-testid="market-preference-section">
      {heading ? (
        <div className="flex flex-col gap-1 px-1">
          <h2 className="type-title text-lg text-text">Region and currency</h2>
          <p className="text-sm text-text-secondary">
            Sets which retailers and prices the Sage uses, and any regional compatibility rules.
          </p>
        </div>
      ) : null}

      <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
        {!loading && markets.length === 0 && (
          <div className="flex items-center gap-2 px-4 py-3 text-caption text-warn" data-testid="catalog-unavailable">
            <Icon icon={Globe} size={15} className="shrink-0" />
            <span>Catalog unavailable: no regions are set up on this server.</span>
          </div>
        )}

        <SettingsRow title="Country or region" description="Which retailers the Sage prices from.">
          {(controlProps) => (
            <Select
              {...controlProps}
              className="bg-bg"
              data-testid="country-select"
              disabled={markets.length === 0}
              value={activeMarket ? activeMarket.code : ""}
              onChange={(e) => handleCountryChange(e.target.value)}
              options={
                markets.length === 0
                  ? [{ value: "", label: loading ? "Loading regions…" : "Catalog unavailable" }]
                  : countryOptions
              }
            />
          )}
        </SettingsRow>

        <SettingsRow title="Currency" description={summary}>
          {(controlProps) => (
            <Select
              {...controlProps}
              className="bg-bg"
              data-testid="currency-select"
              disabled={markets.length === 0}
              value={pref.currencyCode}
              onChange={(e) => handleCurrencyChange(e.target.value)}
              options={currencyOptions}
            />
          )}
        </SettingsRow>
      </div>
    </section>
  );
}
