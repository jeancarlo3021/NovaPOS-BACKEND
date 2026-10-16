# Tipografías de los PDF

`pdfkit` trae solo las 14 fuentes estándar del PDF (Courier, Helvetica…), que
están codificadas en **WinAnsi** y **no tienen el símbolo del colón (₡, U+20A1)**:
se imprimía `¡` en su lugar, en todos los PDF que manda el sistema.

Por eso acá va **Liberation Mono** (licencia SIL OFL 1.1, ver
`LICENSE-LiberationMono.txt`), que tiene el colón y las tildes del español, y es
monoespaciada: los PDF del sistema imitan un tiquete, donde las columnas de
importes tienen que quedar alineadas.

Se cargan con `services/pdfFont.ts`. Si los archivos no estuvieran, ese módulo
cae a Courier y el PDF sale igual —sin el colón, pero sale—: un comprobante que
no se genera es peor que uno con el símbolo feo.
