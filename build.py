"""Build step: desk.html (ORB desk with embedded demo data). index.html is static."""
import pathlib
d = pathlib.Path(__file__).parent / 'www'
t = (d / 'desk_template.html').read_text().replace('__DEMO__', (d / 'tsla.json').read_text())
t = t.replace('<header><h1>', '<header><a href="index.html" style="color:#4c9aff;text-decoration:none;margin-right:6px">←</a><h1>')
(d / 'desk.html').write_text(t)
print('built desk.html')
