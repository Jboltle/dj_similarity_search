# djlinker-callback (GitHub Pages)

Live site: **https://jboltle.github.io/djlinker-callback/** (GitHub canonical host is lowercase.)

This directory in **vdj-link-map** mirrors **https://github.com/Jboltle/djlinker-callback** (branch `main`, Pages source `/`).

`index.html` is a copy of `public/oauth-callback.html` from the parent repo.

## Sync changes to GitHub (after editing here)

From the **parent** project root:

```bash
git clone --depth 1 https://github.com/Jboltle/djlinker-callback.git /tmp/djlinker-callback-push
cp deploy/djlinker-callback/index.html /tmp/djlinker-callback-push/index.html
cp deploy/djlinker-callback/.nojekyll /tmp/djlinker-callback-push/.nojekyll
cd /tmp/djlinker-callback-push
git add index.html .nojekyll
git commit -m "Sync oauth callback from vdj-link-map" && git push
rm -rf /tmp/djlinker-callback-push
```

## SoundCloud + `.env`

Use this exact redirect URI in the SoundCloud app and in `SOUNDCLOUD_REDIRECT_URI`:

`https://jboltle.github.io/djlinker-callback/`
