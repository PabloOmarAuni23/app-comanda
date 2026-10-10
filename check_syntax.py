import ast
import sys

try:
    ast.parse(open('app.py').read())
    print('app.py syntax OK')
except Exception as e:
    print('SYNTAX ERROR:', e)
    sys.exit(1)