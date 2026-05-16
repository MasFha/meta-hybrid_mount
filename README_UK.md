# Hybrid Mount

<img src="https://raw.githubusercontent.com/Hybrid-Mount/meta-hybrid_mount/main/icon.svg" align="right" width="120" />

![Language](https://img.shields.io/badge/Language-Rust-orange?style=flat-square&logo=rust)
![Platform](https://img.shields.io/badge/Platform-Android-green?style=flat-square&logo=android)
![License](https://img.shields.io/badge/License-Apache--2.0-blue?style=flat-square)
![Version](https://img.shields.io/badge/Version-4.0.5-8A2BE2?style=flat-square)

Hybrid Mount — це метамодуль оркестрації монтування для **KernelSU** та **APatch**.
Він поєднує файли модулів із розділами Android через єдиний рушій політик і три backend-и монтування:

- **OverlayFS**: шарове монтування для широкої сумісності.
- **Magic Mount**: bind mount для прямої заміни шляхів або fallback.
- **Kasumi**: маршрутизація на базі LKM із runtime-функціями hide, spoof і stealth.

Вбудована **WebUI на SolidJS** забезпечує графічне керування, моніторинг стану та редагування конфігурації.

Пакети публікуються у трьох варіантах. Якщо не зазначено інше, цей README описує варіант `full`.

**[English](README.md)** &nbsp; **[简体中文](README_ZH.md)** &nbsp; **[繁體中文](README_ZH_TW.md)** &nbsp; **[日本語](README_JP.md)** &nbsp; **[Español](README_ES.md)** &nbsp; **[Italiano](README_IT.md)** &nbsp; **[Русский](README_RU.md)** &nbsp; **[Українська](README_UK.md)** &nbsp; **[Tiếng Việt](README_VI.md)**

---

## Зміст

- [Можливості](#можливості)
- [Варіанти збірки](#варіанти-збірки)
- [Швидкий старт](#швидкий-старт)
- [Режими монтування](#режими-монтування)
- [WebUI](#webui)
- [Підтримка мов](#підтримка-мов)
- [Конфігурація](#конфігурація)
- [Kasumi](#kasumi)
- [Довідник політик](#довідник-політик)
- [CLI](#cli)
- [Архітектура](#архітектура)
- [Збірка](#збірка)
- [Операційні нотатки](#операційні-нотатки)
- [Ліцензія](#ліцензія)

---

## Варіанти збірки

| Варіант | Бінарний файл | WebUI | Daemon / CLI | Kasumi LKM | Сценарій |
|---------|---------------|-------|--------------|------------|----------|
| **Full** | Так | Так | Так | Так | Для користувачів, яким потрібна маршрутизація Kasumi або функції hide/spoof. |
| **Lite** | Так | Так | Так | Ні | Для користувачів, яким потрібні WebUI та повний рушій політик без LKM-based stealth. |
| **Nano** | Так | Ні | Ні | Ні | Для конфігураційного монтування без runtime-daemon, WebUI та CLI. |

### Full

Варіант `full` містить усі підтримувані backend-и (OverlayFS, Magic Mount, Kasumi), WebUI на SolidJS, daemon з Unix socket і HTTP/SSE, CLI та ресурси Kasumi LKM.

### Lite

Варіант `lite` вилучає Kasumi LKM і пов'язані функції, але зберігає WebUI, daemon, CLI, OverlayFS і Magic Mount. Він підходить, якщо ядро не підтримує зовнішні LKM або runtime-можливості hide/spoof не потрібні.

### Nano

Варіант `nano` працює лише через файл конфігурації. Він вилучає WebUI, daemon, CLI та інфраструктуру control plane; залишається невеликий бінарний файл, який читає `config.toml`, будує план монтування, виконує його й завершується.

Nano використовує `magic` як режим за замовчуванням. Під час встановлення вибір клавішами гучності створює порожні marker-файли `overlay` або `magic` у корені керованого модуля. Імена marker-файлів порівнюються без урахування регістру.

### Матриця можливостей

| Можливість | Full | Lite | Nano |
|------------|------|------|------|
| Backend OverlayFS | Так | Так | Через marker-файли |
| Backend Magic Mount | Так | Так | Так, за замовчуванням |
| Backend Kasumi | Так | Ні | Ні |
| WebUI | Так | Так | Ні |
| CLI | Так | Так | Ні |
| Daemon | Так | Так | Ні |
| Кеш конфігурації та runtime-apply | Так | Так | Ні |
| Kasumi hide/spoof/stealth | Так | Ні | Ні |
| Автозавантаження LKM | Так | Ні | Ні |

## Можливості

- **Три backend-и, один рушій політик**: призначення OverlayFS, Magic Mount або Kasumi на рівні окремих шляхів.
- **Детерміноване планування**: конфлікти виявляються під час побудови плану.
- **Вбудована WebUI**: керування модулями, редагування конфігурації та моніторинг runtime-стану.
- **Runtime-інтеграція Kasumi**: автозавантаження LKM, mirror routing, mount hide, spoof maps/statfs, UID hiding, uname spoof і kstat rules.
- **Кеш конфігурації**: інкрементальні patch-зміни та негайне застосування.
- **Відновлення**: автоматичне очищення застарілих runtime-файлів і скидання через `api config-reset`.
- **Автоматизація**: daemon protocol JSON-over-Unix-socket і HTTP API.

---

## Швидкий старт

1. Встановіть [KernelSU](https://kernelsu.org/) або [APatch](https://apatch.dev/) на пристрій.
2. Завантажте ZIP `full`, `lite` або `nano` з [GitHub Releases](https://github.com/Hybrid-Mount/meta-hybrid_mount/releases).
3. Встановіть ZIP через інсталятор модулів root-менеджера.
4. Перезавантажте пристрій. Hybrid Mount визначить середовище й застосує політику overlay за замовчуванням.

```bash
# Перевірити runtime-стан
hybrid-mount daemon status

# Показати виявлені модулі
hybrid-mount api modules-list
```

У варіантах Full/Lite WebUI відкривається із запису модуля в KernelSU або APatch.

### Зміна режиму монтування модуля

```toml
# /data/adb/hybrid-mount/config.toml
[rules.my_module]
default_mode = "magic"

[rules.my_module.paths]
"system/bin/problematic_binary" = "ignore"
```

---

## Режими монтування

| Режим | Backend | Найкраще для |
|-------|---------|--------------|
| `overlay` | OverlayFS | Модулів, що додають або замінюють файли без конфліктів. Режим за замовчуванням. |
| `magic` | Bind mount | Прямої заміни окремих файлів; fallback, коли OverlayFS недоступний. |
| `kasumi` | Kasumi LKM | Явного mirror routing або runtime-функцій hide/spoof. |
| `ignore` | Немає | Виключення конкретних шляхів з обробки монтування. |

OverlayFS підтримує `ext4` як постійне сховище за замовчуванням і `tmpfs` як легкий тимчасовий варіант. Якщо `enable_overlay_fallback = true`, модулі, які не вдалося змонтувати через OverlayFS, повторюються через Magic Mount.

---

## WebUI

WebUI на SolidJS обслуговується daemon-ом через локальний TCP socket з HTTP/SSE. CLI й автоматизовані клієнти використовують Unix socket.

Основні можливості:

- Панель стану зі статистикою, розділами, storage mode і станом daemon.
- Керування модулями та інтерактивна зміна політик.
- Редактор `config.toml` з перевіркою та правилами за шляхами.
- Панель Kasumi для статусу LKM, правил і spoof-налаштувань у Full.

### Підтримка мов

WebUI містить такі locale:

- English (`en-US`, за замовчуванням)
- Español (`es-ES`)
- Italiano (`it-IT`)
- 日本語 (`ja-JP`)
- Русский (`ru-RU`)
- Українська (`uk-UA`)
- Tiếng Việt (`vi-VN`)
- 简体中文 (`zh-CN`)
- 繁體中文 (`zh-TW`)

README-документація доступна [English](README.md), [简体中文](README_ZH.md), [繁體中文](README_ZH_TW.md), [日本語](README_JP.md), [Español](README_ES.md), [Italiano](README_IT.md), [Русский](README_RU.md), [Українська](README_UK.md) та [Tiếng Việt](README_VI.md).

---

## Конфігурація

Шлях за замовчуванням: `/data/adb/hybrid-mount/config.toml`.

| Поле | Тип | За замовчуванням | Опис |
| --- | --- | --- | --- |
| `moduledir` | string | `/data/adb/modules` | Початковий каталог модулів. |
| `mountsource` | string | auto-detect | Runtime-середовище (`KSU`, `APatch`). |
| `overlay_mode` | `ext4` \| `tmpfs` | `ext4` | Сховище upper/work для OverlayFS. |
| `disable_umount` | bool | `false` | Пропуск umount, лише для налагодження. |
| `enable_overlay_fallback` | bool | `false` | Повтор через Magic Mount, якщо OverlayFS недоступний. |
| `default_mode` | `overlay` \| `magic` \| `kasumi` | `overlay` | Глобальна політика за замовчуванням. |
| `daemon_startup_mode` | `on-demand` \| `persistent` | `on-demand` | Режим запуску daemon. |
| `rules` | map | `{}` | Політики за модулями та шляхами. |

---

## Kasumi

Kasumi — backend на базі LKM. Окрім маршрутизації монтувань, він надає функції hide і spoof. Він використовується, коли `kasumi.enabled = true` і план містить правила Kasumi, або коли налаштовані додаткові функції: hidexattr, mount hide, maps/statfs spoof, UID hiding, uname spoof, заміна cmdline чи правила kstat/user hide.

```bash
hybrid-mount kasumi status
hybrid-mount kasumi features
hybrid-mount kasumi list
hybrid-mount lkm status
hybrid-mount kasumi apply-config-runtime
hybrid-mount kasumi clear
```

---

## Довідник політик

Порядок пріоритету:

1. Перевизначення за шляхом: `rules.<module>.paths["<path>"]`
2. Значення модуля за замовчуванням: `rules.<module>.default_mode`
3. Глобальне значення за замовчуванням: `default_mode`

Розпізнавані marker-файли: `disable`, `remove`, `skip_mount`, `mount_error`, `overlay`, `magic` і `.replace`. Імена marker-файлів порівнюються без урахування регістру.

---

## CLI

```bash
hybrid-mount [OPTIONS] [COMMAND]
```

Поширені підкоманди:

- `gen-config`: створити конфігурацію за замовчуванням.
- `logs`: вивести останні логи daemon.
- `api config-get` / `api config-set` / `api config-patch` / `api config-reset`: керування конфігурацією.
- `api modules-list` / `api modules-apply`: перегляд і застосування політик модулів.
- `daemon launch` / `daemon serve` / `daemon status` / `daemon stop`: керування daemon.
- `kasumi ...`: керування Kasumi.
- `lkm load` / `lkm unload` / `lkm status`: керування LKM.

---

## Архітектура

Hybrid Mount читає `config.toml`, знаходить inventory модулів, будує план монтування за правилами шляху, модуля та глобальними правилами, після чого виконує його через OverlayFS, Magic Mount або Kasumi. Варіанти Full/Lite зберігають runtime-стан і відкривають до нього доступ через WebUI та CLI.

Основні каталоги:

- `src/conf`: schema конфігурації, TOML loader, CLI й handlers.
- `src/domain`: основні типи, правила та matching шляхів.
- `src/core`: inventory, планування, daemon, API, startup і runtime state.
- `src/mount`: backend-и OverlayFS, Magic Mount і Kasumi.
- `src/sys`: mount syscalls, LKM і Kasumi UAPI.
- `webui`: SolidJS WebUI та i18n 9 мовами.
- `xtask`: автоматизація збірки й релізу.

---

## Збірка

Вимоги:

- Rust nightly з `rust-toolchain.toml`
- Android NDK r27+ і `cargo-ndk`
- Node.js 20+ і pnpm для WebUI

```bash
cargo run -p xtask -- build --release --flavor full
cargo run -p xtask -- build --release --flavor lite
cargo run -p xtask -- build --release --flavor nano
cargo run -p xtask -- build --release --skip-webui
./scripts/build-local.sh
cargo run -p xtask -- lint
cargo +nightly test
```

---

## Операційні нотатки

- Нові встановлення визначають `mountsource` автоматично.
- Якщо конфігурація пошкоджена, використайте `hybrid-mount api config-reset`, а потім застосовуйте правила поступово.
- `api config-patch --apply-runtime` застосовує часткові зміни одразу.
- У Full Kasumi LKM має відповідати поточному kernel; використайте `lkm_kmi_override`, якщо KMI визначено неправильно.
- `kasumi clear` очищає runtime-стан і звільняє з'єднання з kernel; деякі kernel-side rules можуть зберігатися до перезавантаження LKM.

---

## Ліцензія

Ліцензовано за [Apache-2.0](LICENSE).
