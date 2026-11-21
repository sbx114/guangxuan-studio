# PDF text extraction data

The cmaps/ and standard_fonts/ data are copied without modification from
Mozilla's official pdfjs-dist 6.5.438 npm distribution. The pinned unpdf 2.2.1
serverless parser embeds PDF.js 6.5.438 and uses these matching local assets.

Source: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.5.438.tgz
Project: https://github.com/mozilla/pdf.js

PDF.js is distributed under Apache License 2.0; see LICENSE_PDFJS.
The original CMap and font licensing files are retained in their subdirectories.
No character maps, fonts, or document resources are fetched from the network
while importing a user's document.
