/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Printer, X, Tag } from 'lucide-react';
import { DRY_WANTON_OPTIONS, NOODLE_SIZES, Order, SAUCE_MAP, SpicinessLevel, WANTON_SOUP_OPTIONS } from '../types';
import { calculateSingleOrderDuration } from '../utils/calculations';
import { Language, translations } from '../utils/i18n';

interface ReceiptModalProps {
  order: Order | null;
  onClose: () => void;
  language: Language;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({ order, onClose, language }) => {
  if (!order) return null;

  const t = translations[language];
  const durationInfo = calculateSingleOrderDuration(order);

  const handlePrint = () => {
    window.print();
  };

  const getSpicinessLabel = (s: SpicinessLevel) => {
    switch (s) {
      case 'none':
        return language === 'zh' ? '不辣' : 'Non-Spicy';
      case 'less':
        return language === 'zh' ? '少辣' : 'Mild Spicy';
      case 'normal':
        return language === 'zh' ? '普通辣' : 'Regular Spicy';
      case 'extra':
        return language === 'zh' ? '加辣 🔥' : 'Extra Spicy 🔥';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Thermal Receipt Paper Effect */}
        <div className="rounded-xl border border-dashed border-slate-300 bg-amber-50/50 p-4 text-sm text-slate-800 shadow-inner">
          {/* Header */}
          <div className="text-center border-b border-dashed border-slate-300 pb-3">
            <h2 className="text-lg font-black tracking-tight text-slate-900">{t.receiptStallName}</h2>
            <p className="text-xs text-slate-500">{t.receiptSub}</p>
            <p className="text-[11px] text-slate-400 mt-1">{t.receiptTagline}</p>

            <div className="mt-3 flex items-center justify-between text-xs font-semibold px-2.5 py-1 bg-amber-100/70 rounded-lg">
              <span className="font-bold text-slate-900">
                {order.orderType === 'dine_in'
                  ? `🍽️ ${language === 'zh' ? '堂食' : 'Dine-In'} ${t.mealTokenPrefix}${order.tokenNumber || order.orderNumber.replace(/[^\d]/g, '')}${t.numberUnit}`
                  : `🛍️ ${language === 'zh' ? '打包' : 'Takeaway'} ${t.mealTokenPrefix}${order.tokenNumber || order.orderNumber.replace(/[^\d]/g, '')}${t.numberUnit}`}
              </span>
              <span className="tabular-nums font-mono text-slate-600">
                {new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            {order.orderType === 'takeaway' && (
              <div className="mt-1 text-xs text-rose-600 font-bold">
                {t.takeawayNoSoupNotice}
              </div>
            )}
            <div className="mt-1.5 flex items-center justify-between text-[11px] px-2.5 py-1 bg-slate-100 rounded-lg text-slate-700 font-medium">
              <span>{order.status === 'completed' ? t.orderDurationLabel : t.orderWaitingLabel}</span>
              <span className="font-bold tabular-nums text-slate-900">
                {durationInfo.durationFormatted}
              </span>
            </div>
          </div>

          {/* Items */}
          <div className="py-3 border-b border-dashed border-slate-300 space-y-2">
            {order.items.map((item, idx) => {
              const sauceInfo = item.sauce ? SAUCE_MAP[item.sauce] : null;
              const isSoup = item.type === 'soup' || (item.type === 'noodle' && item.sauce === 'soup');

              return (
                <div key={idx} className="flex justify-between items-start text-xs">
                  <div className="flex-1 pr-2">
                    <div className="font-bold text-slate-900">
                      {item.quantity}x {item.name}
                      {item.isKosong && (
                        <span className="ml-1 px-1 py-0.5 rounded text-[10px] bg-amber-300 text-slate-900 font-black">
                          Kosong 50%
                        </span>
                      )}
                    </div>
                    {item.size && (
                      <div className="text-[11px] text-slate-500">
                        {NOODLE_SIZES[item.size].name}
                        {sauceInfo && !isSoup && ` · ${sauceInfo.chinese}`}
                      </div>
                    )}
                    {item.soupSize && (
                      <div className="text-[11px] text-slate-500">
                        {item.type === 'dry_wanton'
                          ? DRY_WANTON_OPTIONS[item.soupSize].name
                          : WANTON_SOUP_OPTIONS[item.soupSize].name}
                        {sauceInfo && !isSoup && ` · ${sauceInfo.chinese}`}
                      </div>
                    )}

                    {/* Modifiers: Spiciness & Lard only for dry dishes! Soup items omit them */}
                    <div className="text-[10px] text-slate-500 flex flex-wrap gap-1 mt-0.5">
                      {!isSoup ? (
                        <>
                          <span className="text-rose-600 font-bold">[{getSpicinessLabel(item.modifiers.spiciness)}]</span>
                          {item.modifiers.lard === 'extra' && (
                            <span className="text-amber-800 font-semibold">+{language === 'zh' ? '多油渣' : 'Extra Lard'}</span>
                          )}
                          {item.modifiers.lard === 'none' && (
                            <span className="text-rose-600 font-semibold">{language === 'zh' ? '无油渣' : 'No Lard'}</span>
                          )}
                        </>
                      ) : (
                        <span className="text-sky-700 font-semibold">[{language === 'zh' ? '清甜高汤' : 'Clear Broth'}]</span>
                      )}

                      {item.modifiers.scallion === 'extra' && (
                        <span className="text-emerald-700 font-semibold">+{language === 'zh' ? '多葱' : 'Extra Scallion'}</span>
                      )}
                      {item.modifiers.scallion === 'none' && (
                        <span className="text-rose-600 font-semibold">{language === 'zh' ? '走青' : 'No Scallion'}</span>
                      )}
                      {item.modifiers.extraCharSiew && (
                        <span className="text-amber-700 font-semibold">+{language === 'zh' ? '叉烧 (RM2)' : 'Char Siew (RM2)'}</span>
                      )}
                      {item.modifiers.extraWanton && (
                        <span className="text-amber-700 font-semibold">+{language === 'zh' ? '云吞3粒 (RM2)' : 'Wantons 3pcs (RM2)'}</span>
                      )}
                    </div>
                  </div>
                  <div className="tabular-nums font-bold text-slate-900 font-mono">
                    RM {(item.unitPrice * item.quantity).toFixed(2)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Total */}
          <div className="py-2.5 space-y-1">
            <div className="flex justify-between text-xs text-slate-500">
              <span>{t.subtotal}:</span>
              <span className="tabular-nums font-mono">RM {order.subtotal.toFixed(2)}</span>
            </div>
            {order.packagingFee > 0 && (
              <div className="flex justify-between text-xs text-slate-500">
                <span>{language === 'zh' ? '包装费 (Packaging):' : 'Packaging:'}</span>
                <span className="tabular-nums font-mono">RM {order.packagingFee.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-black text-slate-900 pt-1 border-t border-slate-300">
              <span>{t.totalDue}:</span>
              <span className="tabular-nums font-mono text-emerald-700 text-lg">RM {order.totalAmount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-xs text-slate-600 pt-1">
              <span>{language === 'zh' ? '支付方式:' : 'Payment:'}</span>
              <span className="font-semibold">
                {order.paymentMethod === 'cash' ? t.payCash : t.payQr}
              </span>
            </div>
          </div>

          {/* Footer barcode/thank you */}
          <div className="text-center pt-3 border-t border-dashed border-slate-300 text-[10px] text-slate-400">
            <p>{t.thankYou}</p>
            <p className="mt-0.5">Order ID: {order.id.slice(0, 12)}</p>
          </div>
        </div>

        {/* Buttons */}
        <div className="mt-4 flex gap-3">
          <button
            onClick={handlePrint}
            className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white shadow-md hover:bg-slate-800 active:scale-95 transition"
          >
            <Printer className="h-4 w-4" />
            {t.printReceipt}
          </button>
          <button
            onClick={onClose}
            className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 active:scale-95 transition"
          >
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
};
