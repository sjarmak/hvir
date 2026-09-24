import os
import app.util.text as text_module
from typing import TYPE_CHECKING

from . import models
from ..util import text
from ..util.text import slug
from .models import *
from .missing import nothing

if TYPE_CHECKING:
    from app.core.models import Model


class Engine:
    def run(self, name: str) -> str:
        import json

        return json.dumps({"slug": slug(name), "cwd": os.getcwd()})


def build() -> "Model":
    return models.Model()
