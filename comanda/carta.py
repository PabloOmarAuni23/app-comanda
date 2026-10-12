"""Carta de Las Palmeras Pan & Café (https://pabloomarauni23.github.io/PabloLangePage26/#carta).

Cada sección es (categoría, pide_infusión, disponible, productos) y cada producto es
(nombre, descripción, precio). Un precio 0 equivale a "Consultar": hay que cargarlo desde Carta.
"""

INFUSION_OPTIONS = ["Mate", "Mate cocido", "Café", "Café con leche", "Leche cortada", "Té"]

CONSULTAR = "Precio a consultar"

CARTA_SECTIONS = [
    (
        "Desayunos y meriendas",
        True,
        True,
        [
            ("Clásico", "Dos medialunas o tortillas, jugo de naranja. Incluye infusión", 3000),
            ("Light Palmeras", "3 tostadas, queso crema y mermelada, jugo de naranja, yogurt, cereal. Incluye infusión", 4000),
            ("De campo", "Tostada de pan de campo o rescoldo, manteca y dulce de leche, jugo de naranja. Incluye infusión", 4000),
            ("Especial tostado", "Jamón, queso, tomate y orégano. Incluye infusión", 5000),
            ("Energético", "Avena, frutos secos y banana. Incluye infusión", 4500),
            ("Americano", "Huevos revueltos, panceta y toast. Incluye infusión", 5500),
            ("Avocado", "Pan de masa madre, palta y huevo poché. Incluye infusión", 7000),
            ("Sandwich pan sanguchero (Apretado)", "J y Q / S y Q, incluye lata de gaseosa Cm3. Incluye infusión", 5000),
        ],
    ),
    (
        "Momentos especiales",
        False,
        True,
        [
            ("Momento Palmeras", "Café con leche y dos medialunas", 4000),
            ("Relax", "Infusión y porción de torta del día", 4500),
            ("Dulce", "Capuchino y alfajor o brownie", 4000),
            ("Refrescante", "Limonada y tostado simple", 5000),
            ("Promo de licuado", "Dos licuados a elección y un tostado de miga o árabe", 9000),
            ("Saludable", "Licuado y tostada integral", 5500),
        ],
    ),
    (
        "Cafetería",
        False,
        True,
        [
            ("Expresso", "", 2500),
            ("Café con leche", "", 3000),
            ("Leche cortada", "Jarrita o pocillo", 1300),
            ("Cortado", "Jarrita o pocillo", 1300),
            ("Macchiato", "", 3200),
        ],
    ),
    (
        "Bebidas calientes",
        False,
        True,
        [
            ("Capuchino", "", 3000),
            ("Submarino", "", 3500),
            ("Té / infusiones", "", 2500),
            ("Mate cocido", "", 2500),
            ("Chocolatada", "", 3500),
        ],
    ),
    (
        "Para acompañar",
        False,
        True,
        [
            ("Jamón y queso", "", 3500),
            ("Tortilla", "", 3000),
            ("Facturas (2 u.)", "", 2500),
            ("Porción torta", CONSULTAR, 0),
        ],
    ),
    (
        "Sandwich especiales",
        False,
        False,
        [
            ("Palmeras Perú", "Pollo, palta, mayo al ají", 8500),
            ("Palmeras San Martín", "Lomito, lechuga, tomate y huevo", 9000),
        ],
    ),
    (
        "Bebidas en general",
        False,
        True,
        [
            ("Agua saborizada", "", 2000),
            ("Agua mineral", "", 2000),
            ("Gaseosa 500 cc", "", 3000),
            ("Gaseosa 350 cc", "", 2500),
            ("Gaseosa 1500 cc", "", 4500),
            ("Limonada", "", 3500),
            ("Jugo de naranja", "", 3500),
            ("Licuado", CONSULTAR, 0),
        ],
    ),
]

# Relax lleva infusión aunque su sección no la incluya en todos los productos.
INFUSION_EXTRA_PRODUCTS = {"Relax"}
