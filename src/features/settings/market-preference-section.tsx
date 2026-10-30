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
import { Field } from "@/components/ui/primitives";
import { Select } from "@/components/ui/select";
import { Icon } from "@/components/ui/icon";

export function MarketPreferenceSection({
  onChange,
  className,
  initialMarkets
}: {
  onChange?: (pref: MarketPreference) => void;
  className?: string;
  initialMarkets?: readonly MarketMetadata[];
}) {
  const [pref, setPref] = useState<MarketPreference>(() => getMarketPreference());
  const [markets, setMarkets] = useState<MarketMetadata[]>(() =>
    initialMarkets ? [...initialMarkets] : []
  );

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
      });
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

  return (
    <section className={`flex flex-col gap-4 ${className ?? ""}`} data-testid="market-preference-section">
      <div className="flex flex-col gap-1">
        <h2 className="type-title text-xl text-text">Region and currency</h2>
        <p className="text-sm text-text-secondary">
          Sets which retailers and prices the Sage uses, and any regional compatibility rules.
        </p>
      </div>

      <div className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4">
        {markets.length === 0 && (
          <div
            className="flex items-center gap-2 text-caption text-warn"
            data-testid="catalog-unavailable"
          >
            <Icon icon={Globe} size={15} className="shrink-0" />
            <span>Catalog unavailable: no regions are set up on this server.</span>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Country or region">
            {(controlProps) => (
              <Select
                {...controlProps}
                data-testid="country-select"
                aria-label="Country or region"
                disabled={markets.length === 0}
                value={activeMarket ? activeMarket.code : ""}
                onChange={(e) => handleCountryChange(e.target.value)}
                options={
                  markets.length === 0
                    ? [{ value: "", label: "Catalog unavailable" }]
                    : countryOptions
                }
              />
            )}
          </Field>

          <Field label="Currency">
            {(controlProps) => (
              <Select
                {...controlProps}
                data-testid="currency-select"
                aria-label="Currency"
                disabled={markets.length === 0}
                value={pref.currencyCode}
                onChange={(e) => handleCurrencyChange(e.target.value)}
                options={currencyOptions}
              />
            )}
          </Field>
        </div>

        <p className="border-t border-border pt-3 text-caption text-text-secondary">
          {markets.length === 0 ? (
            <>
              Prices show in <span className="font-mono text-text">{pref.currencyCode}</span>.
            </>
          ) : (
            <>
              Showing {activeMarket?.name ?? pref.countryCode} prices in{" "}
              <span className="font-mono text-text">{pref.currencyCode}</span>.
            </>
          )}{" "}
          Saved in this browser.
        </p>
      </div>
    </section>
  );
}
