# Ciasa Irma — Dolomites ski trip booking site

A static site for GitHub Pages, plus a small Google Apps Script backend. The backend stores booking requests in a Google Sheet and emails you one-click Approve and Decline links.

```
index.html            homepage: intro, the deal, cottage, gallery, map, booking
css/style.css         styling
js/config.js          ← everything you'll want to edit (dates, cost, photos, ski areas…)
js/app.js             app logic
apps-script/Code.gs   backend (paste into Google Apps Script)
assets/images/        your photos
```

## 1. Photos
The photos live in `assets/images/` and are listed (with captions) under `gallery` in `js/config.js`. The first one is the hero background. Add `span: 2` or `span: 3` to a photo to make it wider on desktop. When adding photos, keep each under ~500 KB.

## 2. Backend (about 5 minutes)
1. Create a new Google Sheet, for example "Ciasa Irma bookings", using pericakeksic@gmail.com.
2. In the Sheet, open **Extensions → Apps Script**, delete the sample code and paste in all of `apps-script/Code.gs`.
3. Optional: set `SITE_URL` at the top of the script to your GitHub Pages URL.
4. Select the `setup` function and click **Run**. Google asks for permissions (Sheets and sending email). Accept them. Because this is your own unverified script, you'll need to click "Advanced → Go to project".
5. Click **Deploy → New deployment → type: Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the web app URL (`https://script.google.com/macros/s/…/exec`) into `apiUrl` in `js/config.js`.

**"Sorry, unable to open the file at this time"?** This happens when you are signed into more than one Google account. Open the Sheet in an incognito window with only your own account signed in, or use Option B below.

**Option B (standalone script):** go to [script.google.com](https://script.google.com), click **New project**, and paste in `Code.gs`. Set `SHEET_ID` at the top to the ID from your Sheet URL (`docs.google.com/spreadsheets/d/<ID>/edit`). Then continue from step 4.

If you change `Code.gs` later, go to **Deploy → Manage deployments → Edit → Version: New version**. This keeps the same URL.

## 3. Publish on GitHub Pages
1. Create a repo and push these files.
2. Go to **Settings → Pages → Deploy from branch → main / root**.
3. Share `https://<you>.github.io/<repo>/` with your friends.

## How it works
- A friend picks dates and a group size (1–3) and sends the form. The request is saved as **pending**, you get an email with Approve and Decline buttons, and the friend gets a "request received" email.
- **Approve** marks the request as approved, emails the friend and fills the berths on everyone's calendar. Approval is blocked if it would overbook any night.
- Pending requests appear in amber on the calendar, and approved stays appear in red.
- You can also edit the `status` column in the Sheet directly. Valid values are `pending`, `approved` and `declined`.
- On **1 February 2027** the form locks on both the site and the server.

## When you know the cost
In `js/config.js`:
- `totalCostEUR`: once set, the site shows a live estimate per person per night. It also shows how low the price could go if every berth is filled.
- `hostSharesCost`: whether your own 36 nights count in the split. The default is `true`.
- `finalPricePerNight`: set this after 1 February to show the final price.

## Other settings
- `location`: the map pin is approximate (Pera di Fassa, where Strada de Gardecia starts). To fix it, right-click the exact spot in Google Maps and paste the coordinates here.
- `showGuestNames`: shows the first names of approved guests in the calendar tooltips.
- `skiAreas`: the resort list and markers. The figures are approximate.
