# Деплой CryptoSpy на Vercel (бесплатно)

## Вариант 1 — GitHub + Vercel (рекомендуется)

1. Создай репо на GitHub, загрузи папку `crypto-tracker`
2. Зайди на vercel.com → "New Project" → подключи GitHub репо
3. Vercel сам всё настроит — нажми Deploy

Сайт будет на `https://your-project.vercel.app`

## Вариант 2 — Vercel CLI

```bash
npm i -g vercel
cd crypto-tracker
vercel
```

## Добавить Helius API (для реального анализа Solana кошельков)

1. Зарегистрируйся на helius.dev (бесплатно, 1M запросов/месяц)
2. В Vercel → Settings → Environment Variables:
   ```
   HELIUS_API_KEY=your_key_here
   ```
3. Redeploy

## Что работает без ключей
- ✅ Трендовые токены (DEX Screener, бесплатно)
- ✅ Поиск токенов
- ✅ Страница токена с метриками
- ✅ Live Alerts (симуляция)
- ✅ Smart Wallets (оценочные данные по паттернам торгов)
- ⚡ С Helius: реальная история транзакций по любому Solana кошельку
