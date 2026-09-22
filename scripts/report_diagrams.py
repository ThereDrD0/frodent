#!/usr/bin/env python3
"""Generate report diagrams and replace their DOCX placeholders.

The report is intentionally kept dependency-free: SVG is rendered with the
system's rsvg-convert utility and the DOCX package is updated with the Python
standard library only.
"""

from __future__ import annotations

import argparse
import math
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
OFFICE = "urn:schemas-microsoft-com:office:office"
VML = "urn:schemas-microsoft-com:vml"
WORD_10 = "urn:schemas-microsoft-com:office:word"
WPS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
WPG = "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
WP14 = "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
W15 = "http://schemas.microsoft.com/office/word/2012/wordml"


BG = "#F4FBF9"
SURFACE = "#FFFFFF"
SURFACE_LOW = "#EFF5F3"
SURFACE_HIGH = "#E3EAE7"
INK = "#161D1C"
MUTED = "#3F4947"
OUTLINE = "#6F7977"
OUTLINE_LIGHT = "#BEC9C6"
PRIMARY = "#006A63"
PRIMARY_CONTAINER = "#9DF2E8"
SECONDARY = "#CCE8E4"
TERTIARY_CONTAINER = "#CEE5FF"
TERTIARY = "#47617A"
SUCCESS = "#157A65"
TERMINAL = "#18211F"
TERMINAL_TEXT = "#DDEBE8"
TERMINAL_DIM = "#9AB6B0"


def esc(value: object) -> str:
    return escape(str(value))


def attrs(**values: object) -> str:
    return " ".join(f'{key.replace("_", "-")}="{esc(value)}"' for key, value in values.items() if value is not None)


def rect(x: float, y: float, width: float, height: float, fill: str = "none",
         stroke: str = "none", radius: float = 0, stroke_width: float = 2,
         dash: str | None = None, opacity: float | None = None,
         css_class: str | None = None) -> str:
    extra = {"class": css_class} if css_class else {}
    attribute_text = attrs(x=x, y=y, width=width, height=height, rx=radius, fill=fill,
                           stroke=stroke, stroke_width=stroke_width,
                           stroke_dasharray=dash, opacity=opacity, **extra)
    return f'<rect {attribute_text}/>'


def line(x1: float, y1: float, x2: float, y2: float, stroke: str = OUTLINE,
         stroke_width: float = 2, dash: str | None = None,
         marker_end: str | None = None, opacity: float | None = None) -> str:
    attribute_text = attrs(x1=x1, y1=y1, x2=x2, y2=y2, stroke=stroke,
                           stroke_width=stroke_width, stroke_dasharray=dash,
                           marker_end=marker_end, opacity=opacity)
    return f'<line {attribute_text}/>'


def path(d: str, stroke: str = OUTLINE, stroke_width: float = 2,
         fill: str = "none", dash: str | None = None,
         marker_end: str | None = None, opacity: float | None = None) -> str:
    attribute_text = attrs(d=d, stroke=stroke, stroke_width=stroke_width, fill=fill,
                           stroke_dasharray=dash, marker_end=marker_end, opacity=opacity)
    return f'<path {attribute_text}/>'


def circle(cx: float, cy: float, radius: float, fill: str = "none",
           stroke: str = "none", stroke_width: float = 2) -> str:
    return f'<circle {attrs(cx=cx, cy=cy, r=radius, fill=fill, stroke=stroke, stroke_width=stroke_width)}/>'


def ellipse(cx: float, cy: float, rx: float, ry: float, fill: str = SURFACE,
            stroke: str = PRIMARY, stroke_width: float = 2) -> str:
    return f'<ellipse {attrs(cx=cx, cy=cy, rx=rx, ry=ry, fill=fill, stroke=stroke, stroke_width=stroke_width)}/>'


def text(x: float, y: float, value: str, size: float = 24, fill: str = INK,
         weight: int | str = 400, anchor: str = "start", family: str | None = None,
         opacity: float | None = None, letter_spacing: float | None = None,
         baseline: str | None = None, italic: bool = False) -> str:
    attribute_text = attrs(x=x, y=y, fill=fill, font_size=size, font_weight=weight,
                           text_anchor=anchor, font_family=family, opacity=opacity,
                           letter_spacing=letter_spacing, dominant_baseline=baseline,
                           font_style="italic" if italic else None)
    return f'<text {attribute_text}>{esc(value)}</text>'


def multiline(x: float, y: float, lines: list[str], size: float = 24,
             line_height: float | None = None, fill: str = INK,
             weight: int | str = 400, anchor: str = "start",
             family: str | None = None, baseline: str | None = None,
             italic: bool = False) -> str:
    if not lines:
        return ""
    line_height = line_height or size * 1.22
    tspans = []
    for index, value in enumerate(lines):
        dy = 0 if index == 0 else line_height
        tspans.append(f'<tspan x="{esc(x)}" dy="{esc(dy)}">{esc(value)}</tspan>')
    attribute_text = attrs(x=x, y=y, fill=fill, font_size=size, font_weight=weight,
                           text_anchor=anchor, font_family=family,
                           dominant_baseline=baseline,
                           font_style="italic" if italic else None)
    return f'<text {attribute_text}>{"".join(tspans)}</text>'


def centered_multiline(cx: float, cy: float, lines: list[str], size: float = 24,
                       line_height: float | None = None, fill: str = INK,
                       weight: int | str = 400, family: str | None = None) -> str:
    line_height = line_height or size * 1.2
    first_y = cy - ((len(lines) - 1) * line_height) / 2 + size * 0.35
    return multiline(cx, first_y, lines, size, line_height, fill, weight, "middle", family)


def svg_open(width: int, height: int, title: str, dark: bool = False) -> str:
    background = TERMINAL if dark else BG
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
        <title>{esc(title)}</title>
        <defs>
          <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
            <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#163B37" flood-opacity="0.12"/>
          </filter>
          <marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 12 6 L 0 12 z" fill="{PRIMARY}"/>
          </marker>
          <marker id="arrow-muted" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 12 6 L 0 12 z" fill="{OUTLINE}"/>
          </marker>
        </defs>
        {rect(0, 0, width, height, background)}
    '''


def svg_close() -> str:
    return "</svg>"


def section_heading(title: str, subtitle: str, width: int, dark: bool = False) -> str:
    ink = TERMINAL_TEXT if dark else INK
    muted = TERMINAL_DIM if dark else MUTED
    return text(70, 62, title, 34, ink, 700) + text(70, 99, subtitle, 21, muted)


def actor_card(x: float, y: float, title: str, subtitle: str, fill: str) -> str:
    parts = [rect(x, y, 260, 118, fill, OUTLINE_LIGHT, 24, 2, css_class="soft")]
    parts += [circle(x + 42, y + 40, 13, PRIMARY),
              path(f"M {x + 20} {y + 82} Q {x + 42} {y + 59} {x + 64} {y + 82}", PRIMARY, 7),
              text(x + 82, y + 45, title, 25, INK, 700),
              text(x + 82, y + 80, subtitle, 18, MUTED)]
    return "".join(parts)


def usecase(cx: float, cy: float, lines: list[str], fill: str = SURFACE) -> str:
    return ellipse(cx, cy, 190, 48, fill, PRIMARY, 2) + centered_multiline(cx, cy, lines, 22, 25, INK, 600)


def cluster(x: float, y: float, width: float, height: float, title: str,
            subtitle: str, fill: str, stroke: str = PRIMARY) -> str:
    return (
        rect(x, y, width, height, fill, stroke, 24, 2, dash="10 8")
        + text(x + 28, y + 40, title, 25, stroke, 700)
        + text(x + 28, y + 72, subtitle, 17, MUTED)
    )


def make_use_case() -> str:
    width, height = 1800, 1000
    parts = [svg_open(width, height, "Рисунок 2.1 — Use case вариантов использования «Рядом»"),
             section_heading("Use case вариантов использования", "Доступ ролей к функциям интерактивной доски «Рядом»", width)]

    # Connectors are placed behind all nodes so the diagram remains readable.
    parts += [
        line(320, 300, 430, 330, OUTLINE, 3, marker_end="url(#arrow-muted)"),
        line(320, 300, 430, 490, OUTLINE, 2, marker_end="url(#arrow-muted)"),
        line(320, 300, 430, 650, OUTLINE, 2, marker_end="url(#arrow-muted)"),
        line(320, 520, 965, 330, PRIMARY, 3, marker_end="url(#arrow)"),
        line(320, 520, 965, 490, PRIMARY, 3, marker_end="url(#arrow)"),
        line(320, 520, 965, 650, PRIMARY, 3, marker_end="url(#arrow)"),
        line(320, 740, 965, 750, TERTIARY, 3, marker_end="url(#arrow-muted)"),
    ]

    parts += [
        cluster(390, 165, 520, 650, "Локальная доска", "доступна гостю и авторизованному пользователю", SECONDARY),
        cluster(930, 165, 520, 460, "Серверные снимки", "доступны при активной сессии", TERTIARY_CONTAINER, TERTIARY),
        cluster(930, 650, 520, 165, "Администрирование", "доступ с консоли хост-системы", SURFACE_HIGH, TERTIARY),
    ]
    parts += [
        usecase(650, 300, ["Создавать заметки", "и текстовые блоки"], SURFACE),
        usecase(650, 460, ["Рисовать и создавать", "геометрические фигуры"], SURFACE),
        usecase(650, 620, ["Прикреплять файлы", "и работать с Blob"], SURFACE),
        usecase(650, 735, ["Экспортировать / импортировать", ".ryadom"], SURFACE),
        usecase(1190, 325, ["Создавать именованный", "серверный снимок"], SURFACE),
        usecase(1190, 490, ["Загружать снимок", "по идентификатору"], SURFACE),
        usecase(1190, 735, ["Управлять start.mjs", "и PostgreSQL"], SURFACE),
    ]
    parts += [
        actor_card(55, 240, "Гость", "автономный режим", PRIMARY_CONTAINER),
        actor_card(55, 460, "Авторизованный", "токен сессии", TERTIARY_CONTAINER),
        actor_card(55, 680, "Администратор", "консоль хоста", SURFACE_HIGH),
        text(390, 875, "Сплошная связь — доступ роли к группе прецедентов. Локальная синхронизация выполняется через BroadcastChannel.", 19, MUTED),
    ]
    return "".join(parts) + svg_close()


def story_card(x: float, y: float, title: str, lines: list[str], fill: str, accent: str) -> str:
    parts = [rect(x, y, 250, 126, fill, OUTLINE_LIGHT, 18, 2)]
    parts += [rect(x, y, 250, 9, accent, accent, 8, 0), text(x + 19, y + 38, title, 24, INK, 700)]
    parts += [multiline(x + 19, y + 73, lines, 20, 25, MUTED)]
    return "".join(parts)


def make_story_map() -> str:
    width, height = 1800, 1060
    parts = [svg_open(width, height, "Рисунок 2.2 — User story map совместной интерактивной доски «Рядом»"),
             section_heading("User story map", "Путь пользователя: от запуска без сборки до серверной интеграции", width)]
    parts += [
        rect(70, 135, 1660, 75, PRIMARY, PRIMARY, 22, 0),
        text(100, 182, "Цель: быстро выразить идею на бесконечном холсте и сохранить результат", 25, "#FFFFFF", 700),
        text(70, 248, "Основной пользовательский поток", 21, MUTED, 700),
    ]
    columns = [
        ("1", "Инициализация", ["Запустить без", "сборки"], ["Восстановить", "доску из IndexedDB"], ["Показать сетку", "и полотно"], PRIMARY_CONTAINER, PRIMARY),
        ("2", "Создание объектов", ["Стикер и", "текст"], ["Фигура и", "перо"], ["Переместить и", "масштабировать"], SECONDARY, PRIMARY),
        ("3", "Редактирование", ["Двойной клик", "для ввода"], ["Отменить /", "повторить"], ["Сохранить обе", "версии при конфликте"], TERTIARY_CONTAINER, TERTIARY),
        ("4", "Вложения", ["Drag-and-Drop", "или Ctrl+V"], ["Сохранить Blob", "до 20 МБ"], ["Скачать", "оригинал"], "#F8E8B5", "#8A6413"),
        ("5", "Обмен файлами", ["Экспортировать", ".ryadom"], ["Импортировать", "архив"], ["Передать события", "BroadcastChannel"], "#D9F0DD", SUCCESS),
        ("6", "Серверная интеграция", ["Войти по", "логину/паролю"], ["Создать JSON-", "снимок"], ["Загрузить снимок", "по ID"], "#E8DDF5", "#65448A"),
    ]
    x = 70
    column_width = 250
    gap = 28
    for number, title_value, first, second, third, fill, accent in columns:
        parts += [
            rect(x, 275, column_width, 530, SURFACE, OUTLINE_LIGHT, 20, 2),
            rect(x, 275, column_width, 88, fill, fill, 20, 0),
            circle(x + 34, 319, 19, accent),
            text(x + 34, 326, number, 21, "#FFFFFF", 700, "middle"),
            multiline(x + 66, 311, [title_value], 21, 24, INK, 700),
            story_card(x + 0, 388, first[0], first[1:], SURFACE_LOW, accent),
            story_card(x + 0, 526, second[0], second[1:], SURFACE_LOW, accent),
            story_card(x + 0, 664, third[0], third[1:], SURFACE_LOW, accent),
        ]
        x += column_width + gap

    parts += [
        text(70, 865, "Результат каждого шага", 21, MUTED, 700),
        rect(70, 890, 1660, 86, SURFACE, PRIMARY, 22, 2),
        text(105, 943, "локальная доска", 24, PRIMARY, 700),
        line(315, 933, 445, 933, PRIMARY, 3, marker_end="url(#arrow)"),
        text(480, 943, "автономный архив", 24, PRIMARY, 700),
        line(750, 933, 880, 933, PRIMARY, 3, marker_end="url(#arrow)"),
        text(915, 943, "межвкладочный обмен", 24, PRIMARY, 700),
        line(1230, 933, 1360, 933, PRIMARY, 3, marker_end="url(#arrow)"),
        text(1395, 943, "серверный снимок", 24, PRIMARY, 700),
    ]
    return "".join(parts) + svg_close()


def entity_box(x: float, y: float, width: float, height: float, title: str,
              lines: list[str], fill: str = SURFACE, accent: str = PRIMARY,
              mono: bool = False) -> str:
    family = "DejaVu Sans Mono" if mono else None
    parts = [rect(x, y, width, height, fill, accent, 18, 2, css_class="soft"),
             rect(x, y, width, 42, accent, accent, 18, 0),
             rect(x, y + 25, width, 17, accent, accent, 0, 0),
             text(x + 18, y + 29, title, 23, "#FFFFFF", 700)]
    parts.append(multiline(x + 18, y + 76, lines, 20, 26, INK, 500, family=family))
    return "".join(parts)


def storage_boundary(x: float, y: float, width: float, height: float, title: str,
                     subtitle: str, fill: str, accent: str) -> str:
    return (
        rect(x, y, width, height, fill, accent, 24, 2, dash="10 8")
        + text(x + 24, y + 40, title, 25, accent, 700)
        + text(x + 24, y + 72, subtitle, 18, MUTED)
    )


def make_data_storage() -> str:
    width, height = 1800, 1080
    parts = [svg_open(width, height, "Рисунок 2.3 — Схема структуры данных и хранения доски «Рядом»"),
             section_heading("Структура данных и хранения", "Локальная модель Board дополняется архивом и серверными снимками", width)]
    parts += [
        storage_boundary(65, 145, 1080, 845, "Браузер пользователя", "IndexedDB хранит объекты и бинарные вложения локально", SURFACE_LOW, PRIMARY),
        storage_boundary(1190, 145, 545, 845, "Серверный контур", "C++ API и PostgreSQL", TERTIARY_CONTAINER, TERTIARY),
        entity_box(115, 260, 300, 190, "Board", ["id, title", "panX, panY, zoom", "objects[]"], SURFACE, PRIMARY, True),
        entity_box(470, 260, 320, 190, "BoardObject", ["Sticker · Text · Shape", "Stroke · Attachment", "x, y, w, h, z-index"], SURFACE, PRIMARY, True),
        entity_box(845, 260, 245, 190, ".ryadom", ["объекты + Blobs", "экспорт: до 35 МБ", "импорт: до 50 МБ"], "#F8E8B5", "#8A6413"),
        storage_boundary(125, 550, 880, 340, "IndexedDB", "надёжное локальное хранилище", SECONDARY, PRIMARY),
        entity_box(190, 655, 320, 150, "Attachment", ["blobId, name", "MIME-тип, размер", "карточка предпросмотра"], SURFACE, PRIMARY),
        entity_box(620, 655, 320, 150, "AttachmentBlob", ["ключ blobId", "Blob + метаданные", "updatedAt"], SURFACE, PRIMARY, True),
        entity_box(1265, 255, 395, 150, "Session", ["email + пароль", "токен авторизации"], SURFACE, TERTIARY),
        entity_box(1265, 485, 395, 150, "C++ API / proxy", ["/api login", "/api snapshots", "JSON без тяжёлых Blob"], SURFACE, TERTIARY, True),
        entity_box(1265, 715, 395, 150, "Snapshot · PostgreSQL", ["id, email автора", "JSON-структура доски", "дата фиксации"], SURFACE, TERTIARY),
    ]
    parts += [
        line(415, 355, 470, 355, PRIMARY, 3, marker_end="url(#arrow)"),
        text(428, 338, "содержит", 17, MUTED, 600),
        line(790, 355, 845, 355, PRIMARY, 3, marker_end="url(#arrow)"),
        text(800, 338, "сериализация", 17, MUTED, 600),
        line(630, 450, 630, 550, PRIMARY, 3, marker_end="url(#arrow)"),
        text(650, 510, "attachment metadata", 17, MUTED),
        line(510, 730, 620, 730, PRIMARY, 3, marker_end="url(#arrow)"),
        text(520, 710, "blobId", 17, MUTED, 600),
        line(1660, 405, 1660, 485, TERTIARY, 3, marker_end="url(#arrow-muted)"),
        line(1460, 635, 1460, 715, TERTIARY, 3, marker_end="url(#arrow-muted)"),
        line(1090, 355, 1265, 560, PRIMARY, 3, marker_end="url(#arrow)"),
        text(1100, 445, "POST / GET JSON-снимок", 17, PRIMARY, 700),
        line(250, 925, 880, 925, PRIMARY, 2, dash="8 8", marker_end="url(#arrow)"),
        text(260, 955, "BroadcastChannel: события курсоров, штрихов и изменений между вкладками", 18, PRIMARY, 600),
        text(1225, 935, "Оригиналы тяжёлых файлов в серверный Snapshot не входят", 18, TERTIARY, 600),
    ]
    return "".join(parts) + svg_close()


def terminal_frame(title: str, subtitle: str, width: int, height: int) -> list[str]:
    parts = [svg_open(width, height, title, dark=True),
             section_heading(title, subtitle, width, dark=True),
             rect(80, 135, width - 160, height - 205, TERMINAL, "#3A514C", 24, 2),
             rect(80, 135, width - 160, 54, "#24312E", "#3A514C", 24, 2),
             circle(118, 162, 8, "#FF817A"), circle(145, 162, 8, "#F3C969"), circle(172, 162, 8, "#74D5A4"),
             text(215, 169, "terminal — ryadom", 19, TERMINAL_DIM, 500, family="DejaVu Sans Mono")]
    return parts


def terminal_text(x: float, y: float, value: str, fill: str = TERMINAL_TEXT,
                  size: float = 25, weight: int | str = 400) -> str:
    return text(x, y, value, size, fill, weight, family="DejaVu Sans Mono")


def status_pill(x: float, y: float, label: str = "PASS") -> str:
    return rect(x, y - 26, 100, 38, "#204C40", "#3C806B", 19, 1) + text(x + 50, y, label, 20, PRIMARY_CONTAINER, 700, "middle", family="DejaVu Sans Mono")


def make_launcher_test() -> str:
    width, height = 1800, 900
    parts = terminal_frame("Проверка launcher-test и proxy-test", "Успешные проверки запуска, статики и проксирования", width, height)
    y = 245
    parts += [terminal_text(125, y, "$ node scripts/launcher-test.mjs", PRIMARY_CONTAINER, 27, 700)]
    y += 52
    for label in [
        "[launcher] обработка аргументов CLI",
        "[launcher] запуск и останов дочернего процесса",
        "[launcher] режим --frontend",
    ]:
        parts += [terminal_text(150, y, label), status_pill(1390, y)]
        y += 44
    parts += [terminal_text(150, y + 5, "Результат: launcher-test", PRIMARY_CONTAINER, 24, 700)]
    parts += [line(120, y + 43, 1680, y + 43, "#35544D", 2)]
    y += 106
    parts += [terminal_text(125, y, "$ node scripts/proxy-test.mjs", PRIMARY_CONTAINER, 27, 700)]
    y += 52
    for label in [
        "[proxy] отдача index.html и SVG",
        "[proxy] передача заголовков /api",
        "[proxy] корректная ошибка 502",
    ]:
        parts += [terminal_text(150, y, label), status_pill(1390, y)]
        y += 44
    parts += [terminal_text(150, y + 5, "Результат: proxy-test", PRIMARY_CONTAINER, 24, 700),
              text(105, 845, "По таблице 3.3: проверки обработки CLI, статики, заголовков и недоступного C++ бэкенда завершены успешно.", 19, TERMINAL_DIM)]
    return "".join(parts) + svg_close()


def make_browser_test() -> str:
    width, height = 1800, 900
    parts = terminal_frame("Сквозной тест board-test.mjs", "Playwright · headless Chromium · пользовательский сценарий доски", width, height)
    y = 245
    parts += [terminal_text(125, y, "$ node scripts/board-test.mjs", PRIMARY_CONTAINER, 27, 700),
              terminal_text(125, y + 52, "[playwright] browser: Chromium (headless)", TERMINAL_DIM, 23)]
    y += 118
    checks = [
        "canvas видим и инициализирован",
        "стикер создан и текст отредактирован",
        "штрих пера отрисован на Canvas",
        "архив .ryadom экспортирован и импортирован",
    ]
    for label in checks:
        parts += [terminal_text(150, y, f"[board-test] {label}"), status_pill(1390, y)]
        y += 53
    parts += [line(120, y + 12, 1680, y + 12, "#35544D", 2),
              terminal_text(150, y + 70, "E2E result: 1 scenario passed", PRIMARY_CONTAINER, 27, 700),
              terminal_text(150, y + 122, "Проверены создание заметки, рисование пером и Blob-экспорт .ryadom.", TERMINAL_DIM, 21),
              text(105, 845, "Сценарий соответствует описанию сквозного тестирования в таблицах 3.3 и 3.4 отчёта.", 19, TERMINAL_DIM)]
    return "".join(parts) + svg_close()


DIAGRAMS = [
    ("Рисунок 2.1", "figure-2-1-use-case", make_use_case, 1800, 1000),
    ("Рисунок 2.2", "figure-2-2-story-map", make_story_map, 1800, 1060),
    ("Рисунок 2.3", "figure-2-3-data-storage", make_data_storage, 1800, 1080),
    ("Рисунок 3.1", "figure-3-1-tests", make_launcher_test, 1800, 900),
    ("Рисунок 3.2", "figure-3-2-e2e", make_browser_test, 1800, 900),
]


def generate_images(work_dir: Path) -> list[tuple[str, Path, int, int]]:
    generated = []
    for label, stem, factory, width, height in DIAGRAMS:
        svg_path = work_dir / f"{stem}.svg"
        png_path = work_dir / f"{stem}.png"
        svg_path.write_text(factory(), encoding="utf-8")
        subprocess.run(["rsvg-convert", "-w", str(width), "-h", str(height), "-o", str(png_path), str(svg_path)], check=True)
        generated.append((label, png_path, width, height))
    return generated


def qname(namespace: str, local: str) -> str:
    return f"{{{namespace}}}{local}"


def element_text(element: ET.Element) -> str:
    return "".join(node.text or "" for node in element.iter(qname(W, "t")))


def next_relationship_id(rels_root: ET.Element) -> int:
    ids = []
    for relationship in rels_root:
        match = re.fullmatch(r"rId(\d+)", relationship.attrib.get("Id", ""))
        if match:
            ids.append(int(match.group(1)))
    return max(ids, default=0) + 1


def next_media_number(names: list[str]) -> int:
    numbers = []
    for name in names:
        match = re.fullmatch(r"word/media/image(\d+)\.png", name)
        if match:
            numbers.append(int(match.group(1)))
    return max(numbers, default=0) + 1


def make_drawing_xml(rel_id: str, doc_pr_id: int, width_emu: int,
                     height_emu: int, title: str) -> bytes:
    safe_title = escape(title, {'"': "&quot;"})
    return f'''<w:drawing xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="{width_emu}" cy="{height_emu}"/>
      <wp:effectExtent l="0" t="0" r="0" b="0"/>
      <wp:docPr id="{doc_pr_id}" name="{safe_title}" descr="{safe_title}"/>
      <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic><pic:nvPicPr>
          <pic:cNvPr id="{doc_pr_id}" name="{safe_title}"/>
          <pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr>
        </pic:nvPicPr>
        <pic:blipFill><a:blip r:embed="{rel_id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
        <pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="{width_emu}" cy="{height_emu}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </pic:spPr>
        </pic:pic>
      </a:graphicData></a:graphic>
    </wp:inline></w:drawing>'''.encode("utf-8")


def replace_placeholder_table_xml(table: bytes, drawing: bytes) -> bytes:
    cell_start = table.find(b"<w:tc>")
    tc_pr_end = table.find(b"</w:tcPr>", cell_start)
    cell_end = table.find(b"</w:tc>", tc_pr_end)
    if cell_start == -1 or tc_pr_end == -1 or cell_end == -1:
        raise ValueError("В таблице-заполнителе отсутствует ячейка или её свойства")
    paragraph = b'<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>' + drawing + b"</w:r></w:p>"
    return table[:tc_pr_end + len(b"</w:tcPr>")] + paragraph + table[cell_end:]


def update_docx(input_path: Path, output_path: Path, generated: list[tuple[str, Path, int, int]]) -> None:
    with ZipFile(input_path, "r") as archive:
        members = {name: archive.read(name) for name in archive.namelist()}

    document_xml = members["word/document.xml"]
    rels_xml = members["word/_rels/document.xml.rels"]
    rel_ids = [int(value) for value in re.findall(rb'Id="rId(\d+)"', rels_xml)]
    rel_number = max(rel_ids, default=0) + 1
    media_number = next_media_number(list(members))
    doc_pr_ids = [int(value) for value in re.findall(rb'<wp:docPr[^>]*\bid="(\d+)"', document_xml)]
    doc_pr_number = max(doc_pr_ids, default=0) + 1
    width_emu = 5_709_285

    for label, image_path, pixel_width, pixel_height in generated:
        marker = f"[ МЕСТО ДЛЯ ВСТАВКИ ИЛЛЮСТРАЦИИ: {label} ]".encode("utf-8")
        marker_position = document_xml.find(marker)
        if marker_position == -1:
            raise ValueError(f"Не найден placeholder для {label}")
        table_start = document_xml.rfind(b"<w:tbl>", 0, marker_position)
        table_close = document_xml.find(b"</w:tbl>", marker_position)
        if table_start == -1 or table_close == -1:
            raise ValueError(f"Не найдена таблица placeholder для {label}")
        table_close += len(b"</w:tbl>")
        relationship_id = f"rId{rel_number}"
        media_name = f"word/media/image{media_number}.png"
        relationship = (
            f'<Relationship Id="{relationship_id}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
            f'Target="media/image{media_number}.png"/>'
        ).encode("utf-8")
        rels_close = rels_xml.find(b"</Relationships>")
        if rels_close == -1:
            raise ValueError("Не найден конец word/_rels/document.xml.rels")
        rels_xml = rels_xml[:rels_close] + relationship + rels_xml[rels_close:]
        image_height_emu = round(width_emu * pixel_height / pixel_width)
        drawing = make_drawing_xml(relationship_id, doc_pr_number, width_emu, image_height_emu, label)
        table = document_xml[table_start:table_close]
        document_xml = document_xml[:table_start] + replace_placeholder_table_xml(table, drawing) + document_xml[table_close:]
        members[media_name] = image_path.read_bytes()
        rel_number += 1
        media_number += 1
        doc_pr_number += 1
    members["word/document.xml"] = document_xml
    members["word/_rels/document.xml.rels"] = rels_xml

    temporary_output = output_path.with_suffix(output_path.suffix + ".tmp")
    with ZipFile(temporary_output, "w", ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    temporary_output.replace(output_path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="исходный DOCX-файл")
    parser.add_argument("output", type=Path, nargs="?", help="итоговый DOCX-файл; по умолчанию перезаписывает input")
    args = parser.parse_args()
    input_path = args.input.resolve()
    output_path = (args.output or args.input).resolve()
    if not input_path.exists():
        raise SystemExit(f"Не найден файл отчёта: {input_path}")
    if shutil.which("rsvg-convert") is None:
        raise SystemExit("Не найден rsvg-convert — он нужен для подготовки PNG-иллюстраций")

    with tempfile.TemporaryDirectory(prefix="ryadom-report-diagrams-") as temporary:
        generated = generate_images(Path(temporary))
        update_docx(input_path, output_path, generated)
    print(f"Вставлено диаграмм: {len(generated)}")
    print(f"Итоговый документ: {output_path}")


if __name__ == "__main__":
    main()
