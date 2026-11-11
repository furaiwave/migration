<img src="desktop/assets/icon.png" width="72" alt="">

# dbf inspector

Перегляд старих таблиць `.dbf` (dBASE, FoxPro, Visual FoxPro) і перенесення їх у MySQL або MongoDB.

## Завантажити

**[Остання версія для Windows →](https://github.com/furaiwave/migration/releases/latest)**

- `dbf-inspector-setup-<версія>.exe` — інсталятор (ярлик на робочому столі й у меню «Пуск»).
- `dbf-inspector-<версія>-portable.exe` — один файл, без встановлення.

Файли не підписані, тож Windows SmartScreen може попередити під час першого запуску: «Докладніше» → «Однаково запустити».

## Розробка

| Папка | Що там |
|---|---|
| `client` | інтерфейс (React, Vite) — `npm run dev` |
| `migration-gateway` | API (NestJS) — `npm run start:dev` |
| `desktop` | застосунок Electron — `npm run build`, `npm start`; інсталятор — `npm run dist` |

Нова версія для завантаження: `git tag v0.2.0 && git push origin v0.2.0` — GitHub Actions збере інсталятор і опублікує реліз.
