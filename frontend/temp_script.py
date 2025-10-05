from pathlib import Path
import re

path = Path('app/routes.py')
text = path.read_text(encoding='utf-8')
text = text.replace('from typing import Dict\n', 'from typing:']
