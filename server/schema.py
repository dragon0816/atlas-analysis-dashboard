"""Validation for the standalone version-two dashboard document contract."""

from __future__ import annotations

import json
import math

MAX_BYTES = 2_000_000
MAX_DEPTH = 64
MAX_VALUES = 100_000
PANEL_TYPES = frozenset((
    "line", "mask", "bar", "box", "histogram", "stat", "gauge", "table",
    "heatmap", "network", "area", "pie", "donut", "scatter", "text", "status",
    "progress", "timeline",
))
TRANSFORMS = frozenset((
    "filter", "normalize", "join", "group", "aggregate", "calculate", "derive",
    "sort", "limit", "ref",
))
ACTIONS = frozenset((
    "set_filter", "open_details", "navigate", "drill_down", "highlight", "open_link",
))


class InvalidDocument(ValueError):
    """The supplied JSON does not satisfy the dashboard contract."""


def _object(value, label, limit=512, allowed=None):
    if not isinstance(value, dict) or len(value) > limit:
        raise InvalidDocument(f"{label} must be an object with at most {limit} keys")
    if allowed is not None and set(value) - set(allowed):
        raise InvalidDocument(f"{label} has unsupported properties")
    return value


def _text(value, label, limit=4096, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise InvalidDocument(f"{label} must be a {'nonempty ' if required else ''}string")


def _items(value, label, limit):
    if not isinstance(value, list) or len(value) > limit:
        raise InvalidDocument(f"{label} must be an array of at most {limit} items")
    return value


def _variable_value(value):
    if value is None or type(value) in (str, int, float, bool):
        return
    if isinstance(value, list) and len(value) <= 1024 and all(isinstance(v, str) for v in value):
        return
    raise InvalidDocument("Invalid variable value")


def _action(value):
    action = _object(value, "action", allowed=("action", "target", "url", "values"))
    if not isinstance(action.get("action"), str) or action["action"] not in ACTIONS:
        raise InvalidDocument("Unsupported panel action")
    for key in ("target", "url"):
        if key in action:
            _text(action[key], f"action.{key}", 256 if key == "target" else 4096, True)
    if "values" in action:
        _object(action["values"], "action.values")


def validate_document(document):
    """Check bounded JSON and known fields; preserve additional root metadata."""
    pending = [(document, 0)]
    count = 0
    while pending:
        value, depth = pending.pop()
        count += 1
        if depth > MAX_DEPTH or count > MAX_VALUES:
            raise InvalidDocument("Dashboard exceeds its nesting or value limit")
        if value is None or isinstance(value, (str, bool)):
            continue
        if type(value) in (int, float):
            try:
                finite = math.isfinite(value)
            except OverflowError:
                finite = False
            if not finite:
                raise InvalidDocument("Numbers must be finite")
        elif isinstance(value, (list, dict)):
            children = value.values() if isinstance(value, dict) else value
            if isinstance(value, dict) and not all(isinstance(key, str) for key in value):
                raise InvalidDocument("Object keys must be strings")
            if count + len(pending) + len(value) > MAX_VALUES:
                raise InvalidDocument("Dashboard exceeds its value limit")
            pending.extend((child, depth + 1) for child in children)
        else:
            raise InvalidDocument("Only JSON values are supported")
    root = _object(document, "dashboard")
    if type(root.get("schemaVersion")) is not int or root["schemaVersion"] != 2:
        raise InvalidDocument("Only schemaVersion 2 dashboards are supported")
    for key in ("id", "applicationId"):
        _text(root.get(key), key, 256, True)
    _text(root.get("title"), "title")
    if "description" in root:
        _text(root["description"], "description")
    if "presetId" in root:
        _text(root["presetId"], "presetId", 256, True)
    variable_ids = set()
    for value in _items(root.get("variables"), "variables", 128):
        variable = _object(value, "variable", allowed=("id", "label", "type", "default", "options"))
        _text(variable.get("id"), "variable.id", 256, True)
        if variable["id"] in variable_ids:
            raise InvalidDocument("Variable ids must be unique")
        variable_ids.add(variable["id"])
        if "label" in variable:
            _text(variable["label"], "variable.label")
        if "type" in variable and variable["type"] not in ("string", "number", "boolean", "time_range"):
            raise InvalidDocument("Unsupported variable type")
        if "default" in variable:
            _variable_value(variable["default"])
        if "options" in variable:
            for option in _items(variable["options"], "variable.options", 1024):
                if type(option) not in (str, int, float):
                    raise InvalidDocument("Variable options must be strings or numbers")
    if "values" in root:
        for value in _object(root["values"], "values", 128).values():
            _variable_value(value)
    panel_ids = set()
    panel_properties = (
        "id", "title", "type", "datasource", "query", "transform", "mapping",
        "display", "interaction", "layout", "refresh",
    )
    for value in _items(root.get("panels"), "panels", 128):
        panel = _object(value, "panel", allowed=panel_properties)
        _text(panel.get("id"), "panel.id", 256, True)
        _text(panel.get("title"), "panel.title")
        if panel["id"] in panel_ids:
            raise InvalidDocument("Panel ids must be unique")
        panel_ids.add(panel["id"])
        if not isinstance(panel.get("type"), str) or panel["type"] not in PANEL_TYPES:
            raise InvalidDocument("Unsupported panel type")
        source = _object(panel.get("datasource"), "datasource", allowed=("id",))
        _text(source.get("id"), "datasource.id", 256, True)
        if "query" in panel:
            _object(panel["query"], "query")
        for step in _items(panel.get("transform"), "transform", 64):
            _object(step, "transform step", 128)
            if not isinstance(step.get("op"), str) or step["op"] not in TRANSFORMS:
                raise InvalidDocument("Unsupported transform operation")
        for field in _object(panel.get("mapping"), "mapping", 128).values():
            _text(field, "mapping field")
        _object(panel.get("display"), "display")
        if "interaction" in panel:
            interaction = _object(panel["interaction"], "interaction", allowed=("on_click",))
            if "on_click" in interaction:
                actions = interaction["on_click"]
                for action in _items(actions, "on_click", 64) if isinstance(actions, list) else [actions]:
                    _action(action)
        layout = _object(panel.get("layout"), "layout", allowed=("x", "y", "w", "h", "minW", "minH"))
        for dimension in ("x", "y", "w", "h", "minW", "minH"):
            if dimension in ("minW", "minH") and dimension not in layout:
                continue
            size = layout.get(dimension)
            if type(size) is not int or not (0 if dimension in ("x", "y") else 1) <= size <= 100_000:
                raise InvalidDocument(f"Invalid layout.{dimension}")
        if layout.get("minW", 1) > layout["w"] or layout.get("minH", 1) > layout["h"]:
            raise InvalidDocument("Layout minimum exceeds panel size")
        if "refresh" in panel and (type(panel["refresh"]) not in (int, float) or panel["refresh"] < 0):
            raise InvalidDocument("Invalid refresh interval")
    return document


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidDocument("Duplicate JSON object keys are not supported")
        result[key] = value
    return result


def decode_document(payload: bytes):
    if len(payload) > MAX_BYTES:
        raise InvalidDocument("Dashboard exceeds 2 MB")
    try:
        document = json.loads(payload.decode("utf-8"), object_pairs_hook=_unique_object)
        return validate_document(document)
    except (UnicodeError, ValueError, RecursionError, OverflowError) as error:
        raise InvalidDocument("Dashboard must be valid bounded UTF-8 JSON") from error


def encode_document(document):
    validate_document(document)
    try:
        payload = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (UnicodeError, ValueError, RecursionError) as error:
        raise InvalidDocument("Dashboard must be valid UTF-8 JSON") from error
    if len(payload) > MAX_BYTES:
        raise InvalidDocument("Dashboard exceeds 2 MB")
    return payload
