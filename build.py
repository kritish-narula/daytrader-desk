import pathlib;d=pathlib.Path(__file__).parent/'www'
t=(d/'template.html').read_text().replace('__DEMO__',(d/'tsla.json').read_text())
t=t.replace('<title>','<link rel="manifest" href="manifest.json"><meta name="theme-color" content="#0b0f14"><link rel="icon" href="icon.svg"><title>')
t=t.replace('</body>',"<script>if('serviceWorker'in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('sw.js')</script></body>")
(d/'index.html').write_text(t)
