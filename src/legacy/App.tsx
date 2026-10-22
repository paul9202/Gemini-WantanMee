/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { PosView } from './components/PosView';
import { KdsView } from './components/KdsView';
import { AnalyticsView } from './components/AnalyticsView';
import { ReceiptModal } from './components/ReceiptModal';
import { FirebaseModal } from './components/FirebaseModal';
import { ExpenseRecord, Order, WastageRecord } from './types';
import { INITIAL_EXPENSES, INITIAL_ORDERS, INITIAL_WASTAGE } from './data/mockData';

export default function App() {
  // --- Persistent State ---
  const [orders, setOrders] = useState<Order[]>(() => {
    try {
      const saved = localStorage.getItem('pontian_orders_v4');
      if (saved) return JSON.parse(saved);
    } catch {
      // fallback
    }
    return INITIAL_ORDERS;
  });

  const [expenses, setExpenses] = useState<ExpenseRecord[]>(() => {
    try {
      const saved = localStorage.getItem('pontian_expenses');
      if (saved) return JSON.parse(saved);
    } catch {
      // fallback
    }
    return INITIAL_EXPENSES;
  });

  const [wastage, setWastage] = useState<WastageRecord[]>(() => {
    try {
      const saved = localStorage.getItem('pontian_wastage');
      if (saved) return JSON.parse(saved);
    } catch {
      // fallback
    }
    return INITIAL_WASTAGE;
  });

  const [activeView, setActiveView] = useState<'pos' | 'kds' | 'analytics'>(() => {
    try {
      const saved = localStorage.getItem('pontian_active_view');
      if (saved === 'kds' || saved === 'analytics') return saved;
    } catch {
      // fallback
    }
    return 'pos';
  });

  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('pontian_sound');
      if (saved !== null) return saved === 'true';
    } catch {
      // fallback
    }
    return true;
  });

  const [language, setLanguage] = useState<'zh' | 'en'>(() => {
    try {
      const saved = localStorage.getItem('pontian_language');
      if (saved === 'en' || saved === 'zh') return saved;
    } catch {
      // fallback
    }
    return 'zh';
  });

  // Modals & Undo State
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null);
  const [firebaseModalOpen, setFirebaseModalOpen] = useState<boolean>(false);
  const [lastCompletedOrder, setLastCompletedOrder] = useState<Order | null>(null);

  // Sync to LocalStorage
  useEffect(() => {
    try {
      localStorage.setItem('pontian_orders_v4', JSON.stringify(orders));
    } catch {
      // ignore
    }
  }, [orders]);

  useEffect(() => {
    try {
      localStorage.setItem('pontian_expenses', JSON.stringify(expenses));
    } catch {
      // ignore
    }
  }, [expenses]);

  useEffect(() => {
    try {
      localStorage.setItem('pontian_wastage', JSON.stringify(wastage));
    } catch {
      // ignore
    }
  }, [wastage]);

  useEffect(() => {
    try {
      localStorage.setItem('pontian_active_view', activeView);
    } catch {
      // ignore
    }
  }, [activeView]);

  useEffect(() => {
    try {
      localStorage.setItem('pontian_sound', String(soundEnabled));
    } catch {
      // ignore
    }
  }, [soundEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem('pontian_language', language);
    } catch {
      // ignore
    }
  }, [language]);

  const handleToggleLanguage = () => {
    setLanguage((prev) => (prev === 'zh' ? 'en' : 'zh'));
  };

  // Order Handlers
  const handleAddOrder = (newOrder: Order) => {
    setOrders((prev) => [newOrder, ...prev]);
  };

  const handleCompleteOrder = (orderId: string) => {
    setOrders((prev) => {
      const target = prev.find((o) => o.id === orderId);
      if (target) {
        setLastCompletedOrder(target);
      }
      return prev.map((ord) => {
        if (ord.id === orderId) {
          return {
            ...ord,
            status: 'completed',
            completedAt: Date.now(),
          };
        }
        return ord;
      });
    });
  };

  const handleUndoLastCompleted = () => {
    if (!lastCompletedOrder) return;
    setOrders((prev) =>
      prev.map((ord) => {
        if (ord.id === lastCompletedOrder.id) {
          return {
            ...ord,
            status: 'pending',
            completedAt: undefined,
          };
        }
        return ord;
      })
    );
    setLastCompletedOrder(null);
  };

  const handleCancelOrder = (orderId: string) => {
    setOrders((prev) =>
      prev.map((ord) => {
        if (ord.id === orderId) {
          return {
            ...ord,
            status: 'cancelled',
          };
        }
        return ord;
      })
    );
  };

  // Expense Handlers
  const handleAddExpense = (expense: ExpenseRecord) => {
    setExpenses((prev) => [expense, ...prev]);
  };

  const handleDeleteExpense = (id: string) => {
    setExpenses((prev) => prev.filter((e) => e.id !== id));
  };

  // Wastage Handlers
  const handleAddWastage = (record: WastageRecord) => {
    setWastage((prev) => [record, ...prev]);
  };

  // Reset Demo Data
  const handleResetDemo = () => {
    if (window.confirm('确认重置为预装的笨珍云吞面档口演示数据吗？当前新增的测试数据将被重置。')) {
      setOrders(INITIAL_ORDERS);
      setExpenses(INITIAL_EXPENSES);
      setWastage(INITIAL_WASTAGE);
      setLastCompletedOrder(null);
    }
  };

  const pendingOrders = orders.filter((o) => o.status === 'pending');

  return (
    <div className="min-h-screen flex flex-col bg-slate-100 font-sans selection:bg-rose-500 selection:text-white">
      {/* Top Glassmorphic Navigation Bar */}
      <Navbar
        activeView={activeView}
        onViewChange={setActiveView}
        pendingOrders={pendingOrders}
        soundEnabled={soundEnabled}
        onToggleSound={() => setSoundEnabled((prev) => !prev)}
        onResetDemo={handleResetDemo}
        onOpenFirebase={() => setFirebaseModalOpen(true)}
        language={language}
        onToggleLanguage={handleToggleLanguage}
      />

      {/* Main View Display */}
      <main className="flex-1">
        {activeView === 'pos' && (
          <PosView
            orders={orders}
            onAddOrder={handleAddOrder}
            onCompleteOrder={handleCompleteOrder}
            onCancelOrder={handleCancelOrder}
            onPreviewReceipt={(order) => setReceiptOrder(order)}
            soundEnabled={soundEnabled}
            language={language}
          />
        )}

        {activeView === 'kds' && (
          <KdsView
            orders={orders}
            onCompleteOrder={handleCompleteOrder}
            onUndoLastCompleted={handleUndoLastCompleted}
            lastCompletedOrder={lastCompletedOrder}
            soundEnabled={soundEnabled}
            language={language}
          />
        )}

        {activeView === 'analytics' && (
          <AnalyticsView
            orders={orders}
            expenses={expenses}
            wastage={wastage}
            onAddExpense={handleAddExpense}
            onDeleteExpense={handleDeleteExpense}
            onAddWastage={handleAddWastage}
            onOpenFirebase={() => setFirebaseModalOpen(true)}
            language={language}
          />
        )}
      </main>

      {/* Realistic Hawker Thermal Receipt Modal */}
      <ReceiptModal order={receiptOrder} onClose={() => setReceiptOrder(null)} language={language} />

      {/* Firebase Firestore Cloud Sync Modal */}
      <FirebaseModal
        isOpen={firebaseModalOpen}
        onClose={() => setFirebaseModalOpen(false)}
      />
    </div>
  );
}
