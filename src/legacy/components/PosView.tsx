/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import {
  Utensils,
  ShoppingBag,
  Plus,
  Minus,
  Trash2,
  Send,
  Flame,
  Check,
  AlertTriangle,
  Clock,
  Receipt,
  Tag,
  Soup,
} from 'lucide-react';
import {
  CartItem,
  DRY_WANTON_OPTIONS,
  ItemType,
  LardOption,
  NoodleSize,
  NOODLE_SIZES,
  Order,
  OrderItemModifier,
  OrderType,
  PaymentMethod,
  SAUCE_MAP,
  SauceType,
  ScallionOption,
  SpicinessLevel,
  WANTON_SOUP_OPTIONS,
  WantonSoupSize,
} from '../types';
import {
  calculateItemFinancials,
  calculateSingleOrderDuration,
  calculateFulfillmentStats,
} from '../utils/calculations';
import { soundFX } from '../utils/audio';
import { Language, translations } from '../utils/i18n';

export type DishCategory = 'dry_noodle' | 'soup_noodle' | 'dry_wanton' | 'soup';

interface PosViewProps {
  orders: Order[];
  onAddOrder: (newOrder: Order) => void;
  onCompleteOrder: (orderId: string) => void;
  onCancelOrder: (orderId: string) => void;
  onPreviewReceipt: (order: Order) => void;
  soundEnabled: boolean;
  language: Language;
}

export const PosView: React.FC<PosViewProps> = ({
  orders,
  onAddOrder,
  onCompleteOrder,
  onCancelOrder,
  onPreviewReceipt,
  soundEnabled,
  language,
}) => {
  const t = translations[language];

  // --- Order Level State: 按餐牌送餐 ---
  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [selectedToken, setSelectedToken] = useState<number>(1);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');

  // --- Dish Category Selection ---
  // 1) dry_noodle (招牌干捞面)
  // 2) soup_noodle (云吞汤面) -> 去掉辣度与猪油渣
  // 3) dry_wanton (招牌干捞云吞)
  // 4) soup (鲜肉云吞汤) -> 去掉辣度与猪油渣
  const [dishCategory, setDishCategory] = useState<DishCategory>('dry_noodle');

  const [itemType, setItemType] = useState<ItemType>('noodle');
  const [noodleSize, setNoodleSize] = useState<NoodleSize>('small');
  const [soupSize, setSoupSize] = useState<WantonSoupSize>('10pcs');
  const [selectedSauce, setSelectedSauce] = useState<SauceType>('black');
  const [isKosong, setIsKosong] = useState<boolean>(false);

  // Modifiers
  const [modifiers, setModifiers] = useState<OrderItemModifier>({
    extraCharSiew: false,
    extraWanton: false,
    spiciness: 'normal',
    lard: 'normal',
    scallion: 'normal',
  });

  // Cart State
  const [cart, setCart] = useState<CartItem[]>([]);

  // Is this dish a soup-based dish (云吞汤面 or 鲜肉云吞汤)?
  const isSoupDish = dishCategory === 'soup_noodle' || dishCategory === 'soup';

  // Real-time calculation of current item being built
  const currentItemPreview = useMemo(() => {
    // If soup dish, enforce no spiciness and no lard for calculation/cost
    const effectiveModifiers: OrderItemModifier = isSoupDish
      ? { ...modifiers, spiciness: 'none', lard: 'none' }
      : modifiers;

    return calculateItemFinancials(
      itemType,
      itemType === 'noodle' ? noodleSize : undefined,
      itemType === 'soup' || itemType === 'dry_wanton' ? soupSize : undefined,
      itemType === 'noodle' ? isKosong : false,
      effectiveModifiers,
      orderType
    );
  }, [itemType, noodleSize, soupSize, isKosong, modifiers, isSoupDish, orderType]);

  // Handle Kosong Toggle
  const handleToggleKosong = () => {
    if (soundEnabled) soundFX.playTap();
    const nextKosong = !isKosong;
    setIsKosong(nextKosong);
    if (nextKosong) {
      setModifiers((prev) => ({ ...prev, extraCharSiew: false, extraWanton: false }));
    }
  };

  // Handle Extra Char Siew Toggle
  const handleToggleCharSiew = () => {
    if (soundEnabled) soundFX.playTap();
    if (isKosong || itemType !== 'noodle') {
      return;
    }
    setModifiers((prev) => ({ ...prev, extraCharSiew: !prev.extraCharSiew }));
  };

  // Switch dish category
  const handleSelectCategory = (cat: DishCategory) => {
    if (soundEnabled) soundFX.playTap();
    setDishCategory(cat);

    if (cat === 'dry_noodle') {
      setItemType('noodle');
      if (selectedSauce === 'soup') setSelectedSauce('black');
    } else if (cat === 'soup_noodle') {
      setItemType('noodle');
      setSelectedSauce('soup');
      // 云吞汤面去掉辣度与猪油渣
      setModifiers((prev) => ({ ...prev, spiciness: 'none', lard: 'none' }));
    } else if (cat === 'dry_wanton') {
      setItemType('dry_wanton');
      if (selectedSauce === 'soup') setSelectedSauce('black');
      setIsKosong(false);
      setModifiers((prev) => ({ ...prev, extraCharSiew: false, extraWanton: false }));
    } else if (cat === 'soup') {
      setItemType('soup');
      setSelectedSauce('soup');
      setIsKosong(false);
      // 云吞汤去掉辣度与猪油渣
      setModifiers((prev) => ({ ...prev, spiciness: 'none', lard: 'none', extraCharSiew: false }));
    }
  };

  // Add Item to Cart
  const handleAddToCart = () => {
    if (soundEnabled) soundFX.playTap();
    const itemFin = currentItemPreview;

    let itemName = '';
    if (dishCategory === 'dry_noodle') {
      itemName = isKosong
        ? (language === 'zh' ? '招牌干捞面 (⚡ Kosong 净面)' : 'Signature Dry Noodles (Kosong Plain)')
        : (language === 'zh' ? '招牌笨珍干捞面' : 'Signature Dry Pontian Noodles');
    } else if (dishCategory === 'soup_noodle') {
      itemName = isKosong
        ? (language === 'zh' ? '传统云吞汤面 (⚡ Kosong 净面)' : 'Traditional Soup Noodles (Kosong Plain)')
        : (language === 'zh' ? '传统云吞汤面' : 'Traditional Wanton Soup Noodles');
    } else if (dishCategory === 'dry_wanton') {
      itemName = soupSize === '10pcs'
        ? (language === 'zh' ? '招牌干捞云吞 (10粒)' : 'Dry Tossed Wantons (10 pcs)')
        : (language === 'zh' ? '招牌干捞云吞 (15粒)' : 'Dry Tossed Wantons (15 pcs)');
    } else {
      itemName = soupSize === '10pcs'
        ? (language === 'zh' ? '鲜肉云吞汤 (10粒)' : 'Fresh Wanton Soup (10 pcs)')
        : (language === 'zh' ? '鲜肉云吞汤 (15粒)' : 'Fresh Wanton Soup (15 pcs)');
    }

    const finalModifiers: OrderItemModifier = isSoupDish
      ? {
          ...modifiers,
          spiciness: 'none',
          lard: 'none',
        }
      : { ...modifiers };

    const newItem: CartItem = {
      id: 'cart-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
      type: itemType,
      name: itemName,
      size: itemType === 'noodle' ? noodleSize : undefined,
      soupSize: itemType === 'soup' || itemType === 'dry_wanton' ? soupSize : undefined,
      sauce: itemType === 'noodle' || itemType === 'dry_wanton' ? selectedSauce : 'soup',
      isKosong: itemType === 'noodle' ? isKosong : false,
      modifiers: finalModifiers,
      unitPrice: itemFin.unitPrice,
      quantity: 1,
      noodleBallsPerItem: itemFin.noodleBalls,
      wantonCountPerItem: itemFin.wantons,
      bomCostPerItem: itemFin.bomCost,
    };

    setCart((prev) => [...prev, newItem]);

    // Reset Kosong and modifiers for next item
    setIsKosong(false);
    setModifiers({
      extraCharSiew: false,
      extraWanton: false,
      spiciness: isSoupDish ? 'none' : 'normal',
      lard: isSoupDish ? 'none' : 'normal',
      scallion: 'normal',
    });
  };

  // Cart Adjusters
  const updateCartQuantity = (id: string, delta: number) => {
    if (soundEnabled) soundFX.playTap();
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.id === id) {
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter(Boolean) as CartItem[]
    );
  };

  const removeCartItem = (id: string) => {
    if (soundEnabled) soundFX.playTap();
    setCart((prev) => prev.filter((item) => item.id !== id));
  };

  // Cart Totals
  const cartSubtotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  }, [cart]);

  const cartBomTotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.bomCostPerItem * item.quantity, 0);
  }, [cart]);

  const totalNoodleBallsInCart = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.noodleBallsPerItem * item.quantity, 0);
  }, [cart]);

  const totalWantonsInCart = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.wantonCountPerItem * item.quantity, 0);
  }, [cart]);

  // Submit Order to KDS
  const handleSendToKds = () => {
    if (cart.length === 0) return;

    if (soundEnabled) {
      soundFX.playOrderSent();
    }

    const prefix = orderType === 'dine_in'
      ? (language === 'zh' ? '堂食' : 'Dine-In')
      : (language === 'zh' ? '打包' : 'Takeaway');
    const orderNumber = `${prefix} ${t.mealTokenPrefix}${selectedToken}${t.numberUnit}`;

    const newOrder: Order = {
      id: 'ord-' + Date.now(),
      orderNumber,
      orderType,
      tokenNumber: selectedToken,
      takeawayCode: orderType === 'takeaway' ? `T${selectedToken < 10 ? '0' + selectedToken : selectedToken}` : undefined,
      items: [...cart],
      subtotal: Number(cartSubtotal.toFixed(2)),
      packagingFee: 0,
      totalAmount: Number(cartSubtotal.toFixed(2)),
      totalBomCost: Number(cartBomTotal.toFixed(2)),
      paymentMethod,
      status: 'pending',
      createdAt: Date.now(),
      noodleBallsTotal: totalNoodleBallsInCart,
      wantonCountTotal: totalWantonsInCart,
    };

    onAddOrder(newOrder);
    setCart([]);

    // Auto-advance token (1-50)
    setSelectedToken((prev) => (prev < 50 ? prev + 1 : 1));
  };

  // Pending Kitchen Orders
  const pendingOrders = useMemo(() => {
    return orders
      .filter((o) => o.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [orders]);

  const fulfillmentStats = useMemo(() => {
    return calculateFulfillmentStats(orders);
  }, [orders]);

  // Spiciness Label Helper
  const getSpicinessLabel = (s: SpicinessLevel) => {
    switch (s) {
      case 'none':
        return t.spiceNone;
      case 'less':
        return t.spiceLess;
      case 'normal':
        return t.spiceNormal;
      case 'extra':
        return t.spiceExtra;
    }
  };

  return (
    <div className="mx-auto max-w-7xl p-3 sm:p-5">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* ======================================================== */}
        {/* LEFT 7 COLUMNS: Interactive Bento Builder (Zero-Typing)   */}
        {/* ======================================================== */}
        <div className="lg:col-span-7 space-y-4">
          {/* STEP 1: Order Mode & Meal Token Stand (按餐牌送餐) */}
          <div className="rounded-2xl bg-white p-4 shadow-sm border border-slate-200/80">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-black uppercase tracking-wider text-slate-400">
                {t.step1Title}
              </span>
              {orderType === 'takeaway' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 border border-rose-200 px-3 py-1 text-xs font-black text-rose-700 animate-pulse">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t.takeawayNoSoup}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Dine-in Button */}
              <button
                type="button"
                onClick={() => {
                  if (soundEnabled) soundFX.playTap();
                  setOrderType('dine_in');
                }}
                className={`flex h-14 items-center justify-center gap-2.5 rounded-xl border-2 px-4 font-bold text-sm transition-all active:scale-95 ${
                  orderType === 'dine_in'
                    ? 'border-rose-600 bg-rose-50/70 text-rose-900 shadow-sm ring-4 ring-rose-500/15'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                }`}
              >
                <Utensils className={`h-5 w-5 ${orderType === 'dine_in' ? 'text-rose-600' : 'text-slate-500'}`} />
                <span>{t.dineIn}</span>
                {orderType === 'dine_in' && (
                  <span className="rounded-lg bg-rose-600 text-white px-2 py-0.5 text-xs font-black">
                    #{selectedToken}
                  </span>
                )}
              </button>

              {/* Takeaway Button */}
              <button
                type="button"
                onClick={() => {
                  if (soundEnabled) soundFX.playTap();
                  setOrderType('takeaway');
                }}
                className={`flex h-14 items-center justify-center gap-2.5 rounded-xl border-2 px-4 font-bold text-sm transition-all active:scale-95 ${
                  orderType === 'takeaway'
                    ? 'border-amber-500 bg-amber-50/80 text-amber-950 shadow-sm ring-4 ring-amber-500/15'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                }`}
              >
                <ShoppingBag className={`h-5 w-5 ${orderType === 'takeaway' ? 'text-amber-600' : 'text-slate-500'}`} />
                <span>{t.takeaway}</span>
                {orderType === 'takeaway' && (
                  <span className="rounded-lg bg-amber-500 text-white px-2 py-0.5 text-xs font-black">
                    #{selectedToken}
                  </span>
                )}
              </button>
            </div>

            {/* Quick Stand Number 1-50 Grid */}
            <div className="mt-3 pt-3 border-t border-slate-100">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <Tag className={`h-4 w-4 ${orderType === 'dine_in' ? 'text-rose-600' : 'text-amber-600'}`} />
                  <span className="text-xs font-bold text-slate-700">
                    {t.tokenLabel}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedToken((prev) => Math.max(1, prev - 1))}
                    className="h-7 w-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-black flex items-center justify-center text-xs active:scale-90"
                  >
                    -
                  </button>
                  <span
                    className={`text-sm font-black px-2.5 py-0.5 rounded border ${
                      orderType === 'dine_in'
                        ? 'text-rose-600 bg-rose-50 border-rose-200'
                        : 'text-amber-700 bg-amber-50 border-amber-300'
                    }`}
                  >
                    {orderType === 'dine_in' ? (language === 'zh' ? '堂食' : 'Dine-In') : (language === 'zh' ? '打包' : 'Takeaway')} {t.mealTokenPrefix}
                    {selectedToken}
                    {t.numberUnit}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedToken((prev) => Math.min(50, prev + 1))}
                    className="h-7 w-7 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-black flex items-center justify-center text-xs active:scale-90"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto p-1 bg-slate-50 rounded-xl border border-slate-200/60">
                {Array.from({ length: 50 }, (_, i) => i + 1).map((tNum) => (
                  <button
                    key={tNum}
                    type="button"
                    onClick={() => {
                      if (soundEnabled) soundFX.playTap();
                      setSelectedToken(tNum);
                    }}
                    className={`h-9 w-9 rounded-lg text-xs font-extrabold transition-all active:scale-90 ${
                      selectedToken === tNum
                        ? orderType === 'dine_in'
                          ? 'bg-rose-600 text-white shadow-md ring-2 ring-rose-400'
                          : 'bg-amber-500 text-white shadow-md ring-2 ring-amber-400'
                        : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200'
                    }`}
                  >
                    {tNum}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* STEP 2: Dish Selection & Size */}
          <div className="rounded-2xl bg-white p-4 shadow-sm border border-slate-200/80">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-black uppercase tracking-wider text-slate-400">
                {t.step2Title}
              </span>
            </div>

            {/* 4 Primary Dish Tabs (Dry Noodles, Soup Noodles, Dry Wanton, Wanton Soup) */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              {/* Tab 1: 招牌干捞面 */}
              <button
                type="button"
                onClick={() => handleSelectCategory('dry_noodle')}
                className={`py-2 px-2.5 rounded-xl text-xs font-black transition-all border-2 text-center flex flex-col items-center justify-center gap-1 active:scale-95 ${
                  dishCategory === 'dry_noodle'
                    ? 'border-rose-600 bg-rose-50 text-rose-900 shadow-xs ring-2 ring-rose-500/20'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                }`}
              >
                <span className="text-sm">🍜</span>
                <span className="line-clamp-1">{t.catDryNoodle}</span>
              </button>

              {/* Tab 2: 云吞汤面 (去掉辣度与猪油渣) */}
              <button
                type="button"
                onClick={() => handleSelectCategory('soup_noodle')}
                className={`py-2 px-2.5 rounded-xl text-xs font-black transition-all border-2 text-center flex flex-col items-center justify-center gap-1 active:scale-95 ${
                  dishCategory === 'soup_noodle'
                    ? 'border-sky-500 bg-sky-50 text-sky-950 shadow-xs ring-2 ring-sky-500/20'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                }`}
              >
                <span className="text-sm">🥣</span>
                <span className="line-clamp-1">{t.catSoupNoodle}</span>
              </button>

              {/* Tab 3: 招牌干捞云吞 (新功能) */}
              <button
                type="button"
                onClick={() => handleSelectCategory('dry_wanton')}
                className={`py-2 px-2.5 rounded-xl text-xs font-black transition-all border-2 text-center flex flex-col items-center justify-center gap-1 active:scale-95 ${
                  dishCategory === 'dry_wanton'
                    ? 'border-amber-500 bg-amber-50 text-amber-950 shadow-xs ring-2 ring-amber-500/20'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                }`}
              >
                <span className="text-sm">🥢</span>
                <span className="line-clamp-1">{t.catDryWanton}</span>
              </button>

              {/* Tab 4: 鲜肉云吞汤 (去掉辣度与猪油渣) */}
              <button
                type="button"
                onClick={() => handleSelectCategory('soup')}
                className={`py-2 px-2.5 rounded-xl text-xs font-black transition-all border-2 text-center flex flex-col items-center justify-center gap-1 active:scale-95 ${
                  dishCategory === 'soup'
                    ? 'border-sky-500 bg-sky-50 text-sky-950 shadow-xs ring-2 ring-sky-500/20'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                }`}
              >
                <span className="text-sm">🥟</span>
                <span className="line-clamp-1">{t.catSoup}</span>
              </button>
            </div>

            {/* If Noodles (Dry or Soup): 3 Sizes */}
            {(dishCategory === 'dry_noodle' || dishCategory === 'soup_noodle') && (
              <div className="grid grid-cols-3 gap-3">
                {(['small', 'medium', 'large'] as NoodleSize[]).map((sizeKey) => {
                  const opt = NOODLE_SIZES[sizeKey];
                  const isSelected = noodleSize === sizeKey;
                  const displayPrice = isKosong ? opt.kosongPrice : opt.price;

                  const sizeName = sizeKey === 'small' ? t.sizeSmall : sizeKey === 'medium' ? t.sizeMedium : t.sizeLarge;
                  const sizeDesc = sizeKey === 'small' ? t.noodleSmallDesc : sizeKey === 'medium' ? t.noodleMediumDesc : t.noodleLargeDesc;

                  return (
                    <button
                      key={sizeKey}
                      type="button"
                      onClick={() => {
                        if (soundEnabled) soundFX.playTap();
                        setNoodleSize(sizeKey);
                      }}
                      className={`relative flex min-h-[90px] flex-col justify-between rounded-xl border-2 p-3 text-left transition-all active:scale-95 ${
                        isSelected
                          ? dishCategory === 'soup_noodle'
                            ? 'border-sky-500 bg-sky-50/60 shadow-sm ring-4 ring-sky-500/15'
                            : 'border-rose-600 bg-rose-50/50 shadow-sm ring-4 ring-rose-500/15'
                          : 'border-slate-200 bg-slate-50/50 hover:border-slate-300'
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between">
                          <span className="font-black text-sm text-slate-900">{sizeName}</span>
                          {isSelected && <Check className="h-4 w-4 text-rose-600 font-bold" />}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">{sizeDesc}</p>
                      </div>
                      <div className="mt-2 flex items-baseline justify-between border-t border-slate-200/60 pt-1.5">
                        <span className="text-[11px] font-semibold text-slate-500">
                          {opt.noodleBalls} {t.noodleBalls}
                        </span>
                        <div className="text-right">
                          {isKosong && (
                            <span className="text-[10px] line-through text-slate-400 mr-1">
                              RM {opt.price.toFixed(2)}
                            </span>
                          )}
                          <span
                            className={`tabular-nums font-black text-base ${
                              isKosong ? 'text-amber-600' : 'text-rose-600'
                            }`}
                          >
                            RM {displayPrice.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* If Dry Wanton (干捞云吞) or Wanton Soup: 10pcs & 15pcs */}
            {(dishCategory === 'dry_wanton' || dishCategory === 'soup') && (
              <div className="grid grid-cols-2 gap-3">
                {(['10pcs', '15pcs'] as WantonSoupSize[]).map((sKey) => {
                  const opt = dishCategory === 'dry_wanton' ? DRY_WANTON_OPTIONS[sKey] : WANTON_SOUP_OPTIONS[sKey];
                  const isSelected = soupSize === sKey;
                  const sizeName = sKey === '10pcs' ? t.size10pcs : t.size15pcs;

                  return (
                    <button
                      key={sKey}
                      type="button"
                      onClick={() => {
                        if (soundEnabled) soundFX.playTap();
                        setSoupSize(sKey);
                      }}
                      className={`flex min-h-[85px] flex-col justify-between rounded-xl border-2 p-3 text-left transition-all active:scale-95 ${
                        isSelected
                          ? dishCategory === 'dry_wanton'
                            ? 'border-amber-500 bg-amber-50 shadow-sm ring-4 ring-amber-500/15'
                            : 'border-sky-500 bg-sky-50 shadow-sm ring-4 ring-sky-500/15'
                          : 'border-slate-200 bg-slate-50/50 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-black text-sm text-slate-900">{sizeName}</span>
                        {isSelected && <Check className="h-4 w-4 text-emerald-600 font-bold" />}
                      </div>
                      <div className="mt-2 flex items-baseline justify-between border-t border-slate-200/60 pt-1.5">
                        <span className="text-[11px] font-semibold text-slate-500">
                          {opt.wantons} {t.freshWantonsDesc}
                        </span>
                        <span className="tabular-nums font-black text-base text-rose-600">
                          RM {opt.price.toFixed(2)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* STEP 3: Sauce Selection (Only for Dry Noodles and Dry Wanton) */}
          {(dishCategory === 'dry_noodle' || dishCategory === 'dry_wanton') && (
            <div className="rounded-2xl bg-white p-4 shadow-sm border border-slate-200/80">
              <span className="text-xs font-black uppercase tracking-wider text-slate-400 block mb-3">
                {t.step3Title}
              </span>

              <div className="grid grid-cols-3 gap-2.5">
                {(['black', 'white', 'red'] as SauceType[]).map((sKey) => {
                  const sauce = SAUCE_MAP[sKey];
                  const isSelected = selectedSauce === sKey;
                  const sauceName = sKey === 'black' ? t.sauceBlack : sKey === 'white' ? t.sauceWhite : t.sauceRed;
                  const sauceDesc = sKey === 'black' ? t.sauceBlackDesc : sKey === 'white' ? t.sauceWhiteDesc : t.sauceRedDesc;

                  return (
                    <button
                      key={sKey}
                      type="button"
                      onClick={() => {
                        if (soundEnabled) soundFX.playTap();
                        setSelectedSauce(sKey);
                      }}
                      className={`flex min-h-[70px] flex-col justify-between rounded-xl border-2 p-2.5 text-left transition-all active:scale-95 ${
                        isSelected
                          ? `${sauce.borderClass} ${sauce.bgSoft} ring-4 ring-slate-400/20 shadow-md font-black`
                          : 'border-slate-200 bg-slate-50 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black">{sauceName}</span>
                        {isSelected && <Check className="h-4 w-4" />}
                      </div>
                      <p className="text-[10px] text-slate-500 line-clamp-1 mt-1">{sauceDesc}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* STEP 4: 辣度选择 (云吞汤和云吞汤面去掉辣度选择，不需要选！) */}
          {isSoupDish ? (
            <div className="rounded-2xl bg-sky-50 border border-sky-200 p-3.5 shadow-xs flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500 text-white shadow-xs">
                <Soup className="h-5 w-5" />
              </div>
              <div>
                <span className="text-xs font-black text-sky-950 block">
                  {language === 'zh' ? '🥣 清甜老母鸡大骨高汤底 · 免选辣度' : '🥣 Pure Chicken & Bone Broth · No Chili Selection Needed'}
                </span>
                <p className="text-[11px] text-sky-800 mt-0.5">
                  {t.soupNotice}
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl bg-white p-4 shadow-sm border border-slate-200/80">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5">
                  <span className="flex h-2 w-2 rounded-full bg-rose-600 animate-ping" />
                  <span className="text-xs font-black uppercase tracking-wider text-rose-600">
                    {t.step4Title}
                  </span>
                </div>
                <span className="text-xs font-bold text-slate-500">
                  {t.currentSelection}: {getSpicinessLabel(modifiers.spiciness)}
                </span>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {/* 不辣 */}
                <button
                  type="button"
                  onClick={() => {
                    if (soundEnabled) soundFX.playTap();
                    setModifiers((p) => ({ ...p, spiciness: 'none' }));
                  }}
                  className={`flex h-14 flex-col items-center justify-center rounded-xl border-2 text-xs font-black transition-all active:scale-95 ${
                    modifiers.spiciness === 'none'
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-900 ring-4 ring-emerald-500/20 shadow-sm'
                      : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                  }`}
                >
                  <span className="text-sm">{t.spiceNone}</span>
                  <span className="text-[10px] text-slate-500 font-normal mt-0.5">{t.spiceNoneSub}</span>
                </button>

                {/* 少辣 */}
                <button
                  type="button"
                  onClick={() => {
                    if (soundEnabled) soundFX.playTap();
                    setModifiers((p) => ({ ...p, spiciness: 'less' }));
                  }}
                  className={`flex h-14 flex-col items-center justify-center rounded-xl border-2 text-xs font-black transition-all active:scale-95 ${
                    modifiers.spiciness === 'less'
                      ? 'border-amber-500 bg-amber-50 text-amber-900 ring-4 ring-amber-500/20 shadow-sm'
                      : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                  }`}
                >
                  <span className="text-sm">{t.spiceLess}</span>
                  <span className="text-[10px] text-slate-500 font-normal mt-0.5">{t.spiceLessSub}</span>
                </button>

                {/* 普通辣 */}
                <button
                  type="button"
                  onClick={() => {
                    if (soundEnabled) soundFX.playTap();
                    setModifiers((p) => ({ ...p, spiciness: 'normal' }));
                  }}
                  className={`flex h-14 flex-col items-center justify-center rounded-xl border-2 text-xs font-black transition-all active:scale-95 ${
                    modifiers.spiciness === 'normal'
                      ? 'border-orange-500 bg-orange-50 text-orange-950 ring-4 ring-orange-500/20 shadow-sm'
                      : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                  }`}
                >
                  <span className="text-sm">{t.spiceNormal}</span>
                  <span className="text-[10px] text-slate-500 font-normal mt-0.5">{t.spiceNormalSub}</span>
                </button>

                {/* 加辣 */}
                <button
                  type="button"
                  onClick={() => {
                    if (soundEnabled) soundFX.playTap();
                    setModifiers((p) => ({ ...p, spiciness: 'extra' }));
                  }}
                  className={`flex h-14 flex-col items-center justify-center rounded-xl border-2 text-xs font-black transition-all active:scale-95 ${
                    modifiers.spiciness === 'extra'
                      ? 'border-rose-600 bg-rose-50 text-rose-950 ring-4 ring-rose-500/20 shadow-sm'
                      : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                  }`}
                >
                  <span className="text-sm">{t.spiceExtra}</span>
                  <span className="text-[10px] text-slate-500 font-normal mt-0.5">{t.spiceExtraSub}</span>
                </button>
              </div>
            </div>
          )}

          {/* STEP 5: 猪油渣、葱花与加料定制 (云吞汤和云吞汤面去掉猪油渣定制，不需要选！) */}
          <div className="rounded-2xl bg-white p-4 shadow-sm border border-slate-200/80 space-y-3.5">
            <span className="text-xs font-black uppercase tracking-wider text-slate-400 block">
              {t.step5Title}
            </span>

            {/* Kosong Toggle (Noodle Only) */}
            {(dishCategory === 'dry_noodle' || dishCategory === 'soup_noodle') && (
              <button
                type="button"
                onClick={handleToggleKosong}
                className={`w-full min-h-[58px] rounded-xl border-2 p-3 text-left flex items-center justify-between transition-all active:scale-95 ${
                  isKosong
                    ? 'border-amber-400 bg-gradient-to-r from-amber-400 to-amber-300 text-slate-950 font-black shadow-lg ring-4 ring-amber-400/30'
                    : 'border-amber-200/80 bg-amber-50/50 text-amber-900 hover:border-amber-300 hover:bg-amber-50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                      isKosong ? 'bg-slate-950 text-amber-300' : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    <Flame className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-black">{t.kosongBanner}</span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          isKosong ? 'bg-slate-950 text-amber-300' : 'bg-amber-200 text-amber-900'
                        }`}
                      >
                        {t.kosongSub}
                      </span>
                    </div>
                    <p className="text-[11px] opacity-80 mt-0.5">
                      {t.kosongDesc}
                    </p>
                  </div>
                </div>

                <div className="text-right">
                  <div
                    className={`h-6 w-6 rounded-md border flex items-center justify-center ${
                      isKosong ? 'bg-slate-950 border-slate-950 text-amber-300' : 'border-amber-400 bg-white'
                    }`}
                  >
                    {isKosong && <Check className="h-4 w-4 stroke-[3]" />}
                  </div>
                </div>
              </button>
            )}

            {/* 猪油渣定制 (云吞汤和云吞汤面去掉此选项，仅干捞面与干捞云吞展示) */}
            {!isSoupDish && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-bold text-slate-700">{t.lardCustom}</span>
                  <span className="text-[11px] font-semibold text-amber-800">
                    {modifiers.lard === 'normal'
                      ? t.lardNormalFull
                      : modifiers.lard === 'extra'
                      ? t.lardExtraFull
                      : t.lardNoneFull}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (soundEnabled) soundFX.playTap();
                      setModifiers((p) => ({ ...p, lard: 'normal' }));
                    }}
                    className={`h-11 rounded-xl border text-xs font-bold transition active:scale-95 ${
                      modifiers.lard === 'normal'
                        ? 'border-amber-500 bg-amber-50 text-amber-950 ring-2 ring-amber-500/20'
                        : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    {t.lardNormal}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (soundEnabled) soundFX.playTap();
                      setModifiers((p) => ({ ...p, lard: 'extra' }));
                    }}
                    className={`h-11 rounded-xl border text-xs font-bold transition active:scale-95 ${
                      modifiers.lard === 'extra'
                        ? 'border-amber-600 bg-amber-100 text-amber-950 ring-2 ring-amber-500/30'
                        : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    {t.lardExtra}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (soundEnabled) soundFX.playTap();
                      setModifiers((p) => ({ ...p, lard: 'none' }));
                    }}
                    className={`h-11 rounded-xl border text-xs font-bold transition active:scale-95 ${
                      modifiers.lard === 'none'
                        ? 'border-rose-500 bg-rose-50 text-rose-800 ring-2 ring-rose-500/20'
                        : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    {t.lardNone}
                  </button>
                </div>
              </div>
            )}

            {/* 葱花定制 (所有餐品保留) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-bold text-slate-700">{t.scallionCustom}</span>
                <span className="text-[11px] font-semibold text-emerald-800">
                  {modifiers.scallion === 'normal'
                    ? t.scallionNormal
                    : modifiers.scallion === 'extra'
                    ? t.scallionExtra
                    : t.scallionNone}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (soundEnabled) soundFX.playTap();
                    setModifiers((p) => ({ ...p, scallion: 'normal' }));
                  }}
                  className={`h-11 rounded-xl border text-xs font-bold transition active:scale-95 ${
                    modifiers.scallion === 'normal'
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-950 ring-2 ring-emerald-500/20'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {t.scallionNormal}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (soundEnabled) soundFX.playTap();
                    setModifiers((p) => ({ ...p, scallion: 'extra' }));
                  }}
                  className={`h-11 rounded-xl border text-xs font-bold transition active:scale-95 ${
                    modifiers.scallion === 'extra'
                      ? 'border-emerald-600 bg-emerald-100 text-emerald-950 ring-2 ring-emerald-500/30'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {t.scallionExtra}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (soundEnabled) soundFX.playTap();
                    setModifiers((p) => ({ ...p, scallion: 'none' }));
                  }}
                  className={`h-11 rounded-xl border text-xs font-bold transition active:scale-95 ${
                    modifiers.scallion === 'none'
                      ? 'border-rose-500 bg-rose-50 text-rose-800 ring-2 ring-rose-500/20'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {t.scallionNone}
                </button>
              </div>
            </div>

            {/* Paid Add-ons */}
            <div className="grid grid-cols-2 gap-2.5 pt-1 border-t border-slate-100">
              {/* Extra Char Siew (Available for dry noodle & soup noodle, strictly disabled for Kosong & wantons) */}
              <button
                type="button"
                disabled={isKosong || itemType !== 'noodle'}
                onClick={handleToggleCharSiew}
                className={`flex h-13 items-center justify-between rounded-xl border-2 px-3 text-xs font-bold transition-all active:scale-95 ${
                  isKosong || itemType !== 'noodle'
                    ? 'opacity-40 cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                    : modifiers.extraCharSiew
                    ? 'border-amber-600 bg-amber-50 text-amber-900 ring-2 ring-amber-500/20'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                }`}
              >
                <span>{language === 'zh' ? '🥩 +加叉烧' : '🥩 +Extra Char Siew'}</span>
                <span className="tabular-nums font-black text-rose-600">+RM 2.00</span>
              </button>

              {/* Extra Wantons (+3 pcs RM2.00) */}
              <button
                type="button"
                disabled={isKosong}
                onClick={() => {
                  if (soundEnabled) soundFX.playTap();
                  setModifiers((prev) => ({ ...prev, extraWanton: !prev.extraWanton }));
                }}
                className={`flex h-13 items-center justify-between rounded-xl border-2 px-3 text-xs font-bold transition-all active:scale-95 ${
                  isKosong
                    ? 'opacity-40 cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                    : modifiers.extraWanton
                    ? 'border-amber-600 bg-amber-50 text-amber-900 ring-2 ring-amber-500/20'
                    : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300'
                }`}
              >
                <span>{language === 'zh' ? '🥟 +加云吞 (3粒)' : '🥟 +Extra Wantons (3pcs)'}</span>
                <span className="tabular-nums font-black text-rose-600">+RM 2.00</span>
              </button>
            </div>
          </div>

          {/* Primary CTA Button */}
          <button
            type="button"
            onClick={handleAddToCart}
            className="w-full h-16 rounded-2xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white font-extrabold text-base shadow-lg shadow-rose-600/25 flex items-center justify-between px-6 transition-all active:scale-98"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/20">
                <Plus className="h-6 w-6 stroke-[3]" />
              </div>
              <div className="text-left">
                <div className="text-base font-black">{t.addToCart}</div>
                <div className="text-xs text-rose-100 font-normal">
                  {itemType === 'noodle'
                    ? `${dishCategory === 'soup_noodle' ? t.catSoupNoodle : t.catDryNoodle} · ${NOODLE_SIZES[noodleSize].name}${
                        isSoupDish ? '' : ` · ${SAUCE_MAP[selectedSauce].chinese} · ${getSpicinessLabel(modifiers.spiciness)}`
                      }${isKosong ? ' · Kosong' : ''}`
                    : `${dishCategory === 'dry_wanton' ? t.catDryWanton : t.catSoup} · ${
                        soupSize === '10pcs' ? t.size10pcs : t.size15pcs
                      }${dishCategory === 'dry_wanton' ? ` · ${SAUCE_MAP[selectedSauce].chinese}` : ''}`}
                </div>
              </div>
            </div>

            <div className="text-right">
              <span className="text-xs text-rose-200 block">{language === 'zh' ? '单份小计' : 'Unit Price'}</span>
              <span className="text-2xl font-black tabular-nums tracking-tight">
                RM {currentItemPreview.unitPrice.toFixed(2)}
              </span>
            </div>
          </button>
        </div>

        {/* ======================================================== */}
        {/* RIGHT 5 COLUMNS: Cart & Live Kitchen Queue                */}
        {/* ======================================================== */}
        <div className="lg:col-span-5 space-y-4">
          {/* Current Ticket Cart */}
          <div className="rounded-2xl bg-white p-4 shadow-sm border border-slate-200/80 flex flex-col min-h-[420px]">
            {/* Ticket Header */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-black text-slate-900">
                  {orderType === 'dine_in'
                    ? `${t.dineIn} ${t.mealTokenPrefix}${selectedToken}${t.numberUnit}`
                    : `${t.takeaway} ${t.mealTokenPrefix}${selectedToken}${t.numberUnit}`}
                </span>
                {orderType === 'takeaway' && (
                  <span className="rounded bg-rose-100 text-rose-700 px-1.5 py-0.5 text-[10px] font-black">
                    {language === 'zh' ? '免汤' : 'No Soup'}
                  </span>
                )}
              </div>

              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCart([])}
                  className="text-xs text-slate-400 hover:text-rose-600 transition flex items-center gap-1"
                >
                  <Trash2 className="h-3 w-3" /> {t.clearCart}
                </button>
              )}
            </div>

            {/* Cart Items List */}
            <div className="flex-1 overflow-y-auto py-2 space-y-2.5 max-h-[220px]">
              {cart.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-44 text-slate-400 text-center">
                  <Utensils className="h-8 w-8 text-slate-300 mb-2 stroke-1" />
                  <p className="text-xs font-semibold">{t.cartEmpty}</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{t.cartEmptyDesc}</p>
                </div>
              ) : (
                cart.map((item) => {
                  const itemIsSoup = item.type === 'soup' || (item.type === 'noodle' && item.sauce === 'soup');

                  return (
                    <div
                      key={item.id}
                      className="rounded-xl bg-slate-50 p-2.5 border border-slate-200/70 flex items-center justify-between gap-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-black text-slate-900">{item.name}</span>
                          {item.isKosong && (
                            <span className="rounded bg-amber-400 text-slate-950 px-1.5 py-0.2 text-[9px] font-black">
                              Kosong 50%
                            </span>
                          )}
                          {item.sauce && (
                            <span
                              className={`rounded px-1.5 py-0.2 text-[9px] font-bold ${
                                SAUCE_MAP[item.sauce].badgeClass
                              }`}
                            >
                              {SAUCE_MAP[item.sauce].chinese}
                            </span>
                          )}
                        </div>

                        {/* Modifiers line - clean for soup dishes! */}
                        <div className="text-[10px] text-slate-500 mt-0.5 flex flex-wrap gap-1">
                          {item.size && <span>{NOODLE_SIZES[item.size].name}</span>}
                          {item.soupSize && (
                            <span>
                              {item.type === 'dry_wanton'
                                ? DRY_WANTON_OPTIONS[item.soupSize].name
                                : WANTON_SOUP_OPTIONS[item.soupSize].name}
                            </span>
                          )}

                          {/* Only show spiciness & lard for non-soup items */}
                          {!itemIsSoup && (
                            <>
                              <span className="text-rose-600 font-bold">
                                [{getSpicinessLabel(item.modifiers.spiciness)}]
                              </span>
                              {item.modifiers.lard === 'extra' && (
                                <span className="text-amber-800">+{language === 'zh' ? '多油渣' : 'Extra Lard'}</span>
                              )}
                              {item.modifiers.lard === 'none' && (
                                <span className="text-rose-600">{language === 'zh' ? '无油渣' : 'No Lard'}</span>
                              )}
                            </>
                          )}

                          {itemIsSoup && (
                            <span className="text-sky-700 font-semibold">
                              [{language === 'zh' ? '原汁骨汤' : 'Bone Broth'}]
                            </span>
                          )}

                          {item.modifiers.scallion === 'extra' && (
                            <span className="text-emerald-700">+{language === 'zh' ? '多葱' : 'Extra Scallion'}</span>
                          )}
                          {item.modifiers.scallion === 'none' && (
                            <span className="text-rose-600">{language === 'zh' ? '走青' : 'No Scallion'}</span>
                          )}
                          {item.modifiers.extraCharSiew && (
                            <span className="text-amber-700">+{language === 'zh' ? '叉烧' : 'Char Siew'}</span>
                          )}
                          {item.modifiers.extraWanton && (
                            <span className="text-sky-700">+{language === 'zh' ? '云吞' : 'Wantons'}</span>
                          )}
                        </div>
                      </div>

                      {/* Qty +/- & Price */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-xs font-black tabular-nums text-slate-900 mr-1">
                          RM {(item.unitPrice * item.quantity).toFixed(2)}
                        </span>
                        <button
                          type="button"
                          onClick={() => updateCartQuantity(item.id, -1)}
                          className="h-7 w-7 rounded flex items-center justify-center text-slate-600 hover:bg-slate-200 active:scale-90"
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <span className="text-xs font-black w-4 text-center">{item.quantity}</span>
                        <button
                          type="button"
                          onClick={() => updateCartQuantity(item.id, 1)}
                          className="h-7 w-7 rounded flex items-center justify-center text-slate-600 hover:bg-slate-200 active:scale-90"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Cart Footer & Payment Controls */}
            <div className="border-t border-slate-100 pt-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (soundEnabled) soundFX.playTap();
                    setPaymentMethod('cash');
                  }}
                  className={`flex h-11 items-center justify-center gap-1.5 rounded-xl border text-xs font-bold transition active:scale-95 ${
                    paymentMethod === 'cash'
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-500/20'
                      : 'border-slate-200 bg-slate-50 text-slate-600'
                  }`}
                >
                  <span>{t.payCash}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (soundEnabled) soundFX.playTap();
                    setPaymentMethod('qr');
                  }}
                  className={`flex h-11 items-center justify-center gap-1.5 rounded-xl border text-xs font-bold transition active:scale-95 ${
                    paymentMethod === 'qr'
                      ? 'border-sky-600 bg-sky-50 text-sky-900 ring-2 ring-sky-500/20'
                      : 'border-slate-200 bg-slate-50 text-slate-600'
                  }`}
                >
                  <span>{t.payQr}</span>
                </button>
              </div>

              {/* Total & Send to Kitchen Button */}
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs text-slate-400 font-semibold block">{t.cartTotalAmount}</span>
                  <div className="text-3xl font-black text-slate-900 tabular-nums">
                    RM {cartSubtotal.toFixed(2)}
                  </div>
                </div>

                <button
                  type="button"
                  disabled={cart.length === 0}
                  onClick={handleSendToKds}
                  className={`flex h-14 min-w-[170px] items-center justify-center gap-2 rounded-xl px-5 text-sm font-black shadow-md transition-all active:scale-95 ${
                    cart.length > 0
                      ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/25 ring-2 ring-emerald-500/40'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <Send className="h-4 w-4" />
                  <span>{t.sendToKds}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Active Kitchen Queue */}
          <div className="rounded-2xl bg-white p-4 shadow-sm border border-slate-200/80">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-black uppercase tracking-wider text-slate-400">
                  {language === 'zh' ? '厨房待做实时队列' : 'Active Kitchen Queue'}
                </span>
                <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[10px] font-black tabular-nums">
                  {pendingOrders.length} {language === 'zh' ? '单' : 'orders'}
                </span>
              </div>

              <div className="flex items-center gap-2 text-[11px] font-bold">
                <span className="bg-amber-50 text-amber-800 border border-amber-200/80 px-2 py-0.5 rounded-lg flex items-center gap-1">
                  <Clock className="h-3 w-3 text-amber-600" />
                  {language === 'zh' ? '预估等候 ~' : 'Est. Wait ~'}{fulfillmentStats.estimatedNextOrderWaitMinutes}{language === 'zh' ? '分钟' : ' min'}
                </span>
              </div>
            </div>

            <div className="space-y-2 max-h-[260px] overflow-y-auto">
              {pendingOrders.length === 0 ? (
                <div className="py-8 text-center text-slate-400 text-xs">
                  {language === 'zh' ? '暂无待做订单，档口出餐完毕！' : 'No pending orders in kitchen!'}
                </div>
              ) : (
                pendingOrders.map((ord) => {
                  const durationInfo = calculateSingleOrderDuration(ord);

                  return (
                    <div
                      key={ord.id}
                      className={`rounded-xl p-3 border transition-all ${
                        durationInfo.speedRating === 'overdue'
                          ? 'border-rose-400 bg-rose-50/90'
                          : durationInfo.speedRating === 'slow'
                          ? 'border-amber-300 bg-amber-50/70'
                          : 'border-slate-200 bg-slate-50/70 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-black text-slate-900">{ord.orderNumber}</span>
                          <span
                            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              durationInfo.speedRating === 'overdue'
                                ? 'bg-rose-600 text-white animate-pulse'
                                : durationInfo.speedRating === 'slow'
                                ? 'bg-amber-500 text-white'
                                : 'bg-slate-200 text-slate-700'
                            }`}
                          >
                            <Clock className="h-3 w-3" />
                            {durationInfo.durationFormatted}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                          {/* Print Receipt Preview */}
                          <button
                            type="button"
                            onClick={() => onPreviewReceipt(ord)}
                            title={t.printReceipt}
                            className="rounded-lg bg-white border border-slate-200 p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition active:scale-90"
                          >
                            <Receipt className="h-3.5 w-3.5" />
                          </button>

                          {/* Quick complete */}
                          <button
                            type="button"
                            onClick={() => onCompleteOrder(ord.id)}
                            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 text-xs font-bold transition active:scale-95"
                          >
                            {language === 'zh' ? '出餐' : 'Done'}
                          </button>
                        </div>
                      </div>

                      {/* Brief Items Summary */}
                      <div className="text-[11px] text-slate-600 mt-1.5 space-y-0.5">
                        {ord.items.map((it, idx) => {
                          const itIsSoup = it.type === 'soup' || (it.type === 'noodle' && it.sauce === 'soup');

                          return (
                            <div key={idx} className="flex justify-between items-center">
                              <span>
                                {it.quantity}x {it.name}
                                {it.isKosong && (
                                  <span className="ml-1 text-[10px] font-black text-amber-600">
                                    [Kosong]
                                  </span>
                                )}
                                {it.sauce && ` · ${SAUCE_MAP[it.sauce].chinese}`}
                                {!itIsSoup && (
                                  <span className="ml-1 text-[10px] text-rose-600 font-bold">
                                    [{getSpicinessLabel(it.modifiers.spiciness)}]
                                  </span>
                                )}
                              </span>
                              <span className="tabular-nums font-semibold text-slate-700">
                                RM {(it.unitPrice * it.quantity).toFixed(2)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
