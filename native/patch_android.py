"""Applied in CI after `npx cap add android`: native plugin, manifest hardening, release signing."""
import pathlib, re, shutil, os
A = pathlib.Path('android/app')
pkg = A / 'src/main/java/com/boomai/daytraderdesk'
pkg.mkdir(parents=True, exist_ok=True)
for f in ('MainActivity.java', 'ScanService.java', 'ScanKeeperPlugin.java'):
    shutil.copy(pathlib.Path('native') / f, pkg / f)
m = A / 'src/main/AndroidManifest.xml'; x = m.read_text()
perms = ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_DATA_SYNC', 'android.permission.POST_NOTIFICATIONS', 'android.permission.WAKE_LOCK']
for p in perms:
    if p not in x:
        x = x.replace('</manifest>', f'    <uses-permission android:name="{p}" />\n</manifest>')
x = x.replace('android:allowBackup="true"', 'android:allowBackup="false" android:fullBackupContent="false"')
if 'android:allowBackup' not in x:
    x = x.replace('<application', '<application android:allowBackup="false"', 1)
if 'ScanService' not in x:
    x = x.replace('</application>', '        <service android:name=".ScanService" android:exported="false" android:stopWithTask="true" android:foregroundServiceType="dataSync" />\n    </application>')
m.write_text(x)
# release signing from env (GitHub secrets); falls back to debug build when absent
g = A / 'build.gradle'; s = g.read_text()
if os.environ.get('KS_B64') and 'signingConfigs' not in s:
    s = s.replace('buildTypes {', '''signingConfigs {
        release {
            storeFile file("release.keystore")
            storePassword System.getenv("KS_PASS")
            keyAlias "dtd"
            keyPassword System.getenv("KS_PASS")
        }
    }
    buildTypes {''', 1)
    s = re.sub(r'(release\s*\{)(\s*minifyEnabled)', r'\1\n            signingConfig signingConfigs.release\2', s, count=1)
s += '\nconfigurations.all { exclude group: "org.jetbrains.kotlin", module: "kotlin-stdlib-jdk7"; exclude group: "org.jetbrains.kotlin", module: "kotlin-stdlib-jdk8" }\n'
g.write_text(s)
print('android patched; release signing:', bool(os.environ.get('KS_B64')))
