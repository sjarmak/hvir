from __future__ import annotations

import re


def slug(name: str) -> str:
    return re.sub(r"\W+", "-", name).lower()
