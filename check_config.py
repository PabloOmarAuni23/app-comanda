import ast
import sys

# Llama a la función de verificación de sintaxis
exec(open('check_syntax.py').read())

# Verificar variables clave
with open('app.py') as f:
    tree = ast.parse(f.read())

for node in tree.body:
    if isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Name):
                if target.id in {'DATABASE_URL', 'DATABASE_PATH', 'ENV', 'PORT', 'SQLALCHEMY_DATABASE_URI', 'DB_NAME', 'DB_PATH', 'app'}:
                    print(f"Definido: {target.id}")