/*
 * Ciasa Irma — site configuration.
 * Everything you are likely to want to tweak lives in this file.
 */
window.CONFIG = {
  // Paste the Google Apps Script web-app URL here after deploying apps-script/Code.gs
  // (see README.md). While empty, the site runs in DEMO MODE: bookings are stored
  // only in your own browser so you can click around safely.
  apiUrl: "https://script.google.com/macros/s/AKfycbzeYn0b6Vrj3qkNcnd0iKfSGJE41I23cdcvvUZR7dmma_GizyMZUCQiLP9wPZrXhLiH/exec",

  cottageName: "Ciasa Irma",
  address: "Strada de Gardecia 7, 38036 San Giovanni di Fassa (TN), Italy",
  // Approximate location (Pera di Fassa, where Strada de Gardecia starts).
  // Fine-tune by right-clicking the spot in Google Maps and copying the coordinates.
  location: { lat: 46.4418, lng: 11.6918 },

  // Trip window. First night = arrival date of tripStart, last check-out = tripEnd.
  tripStart: "2027-02-13",
  tripEnd: "2027-03-21",
  totalBeds: 4,
  hostBeds: 1, // you occupy one berth for the whole stay
  maxGroupSize: 3,

  // Booking closes and the price gets fixed at this moment (local time, CET).
  lockDate: "2027-02-01T00:00:00+01:00",

  // Total cottage cost for the whole stay in EUR. Leave null until you know it —
  // the site will then explain the formula without showing numbers.
  totalCostEUR: null,
  // Whether your own nights count when dividing the cost (true = you pay your share too).
  hostSharesCost: true,
  // Once the price is fixed, put the final per-person-per-night price here (EUR).
  finalPricePerNight: null,

  // Show first names of approved guests on the calendar ("who's there").
  showGuestNames: true,

  hostName: "Your host",

  // Gallery: drop your photos into assets/images/ and list them here.
  // The first image is also used as the hero background. Add `span: 2` or `span: 3` to make a photo wider (desktop only).
  gallery: [
    { src: "assets/images/images-trn-1-6f074f0a-a2c0-4992-8a87-d35fffa262d7-99-image.jpg", caption: "Winter view from the balcony, slopes across the valley" },
    { src: "assets/images/images-trn-1-1e3055da-cb7b-4998-93f2-89636b8c27d0-99-image.jpg", caption: "The stube: bunk beds, sofa and dining table" },
    { src: "assets/images/images-trn-1-a34dece5-a246-4dcc-932b-71dafed87e85-99-image.jpg", caption: "Wood-panelled living room" },
    { src: "assets/images/images-trn-1-2bd85abc-4c58-4ad9-8685-167f9b885bdf-99-image.jpg", caption: "Double bedroom" },
    { src: "assets/images/images-trn-1-8aa717c4-c5bd-47f6-9386-9a637ba55a7f-99-image.jpg", caption: "Kitchen with traditional wood stove" },
    { src: "assets/images/images-trn-1-47cf72dd-cd40-48bd-95ac-0f86bdf95660-99-image.jpg", caption: "Sunset over the Sella group from the cottage road", span: 3 },
    { src: "assets/images/images-trn-1-47e91244-fab6-4c20-b532-8026b4ce23cf-99-image.jpg", caption: "Bathroom with bathtub and washing machine" },
  ],

  // Cottage facts shown on the homepage. Edit freely.
  features: [
    { icon: "bed", title: "4 berths", text: "A double bedroom plus a bunk bed in the stube. One berth is mine; three are up for grabs." },
    { icon: "mountain", title: "Val di Fassa", text: "In Pera di Fassa, at the foot of the Catinaccio / Rosengarten group." },
    { icon: "ski", title: "Dolomiti Superski", text: "Buffaure, Catinaccio and the Sella Ronda are a short drive or ski-bus ride away." },
    { icon: "fire", title: "Après-ski base", text: "Come back to a warm stube, shared dinners and plenty of grappa-fuelled planning." },
  ],

  // Nearby ski areas (approximate figures — always check dolomitisuperski.com).
  skiAreas: [
    { name: "Buffaure", village: "Pozza di Fassa", lat: 46.4290, lng: 11.6838, top: 2354, km: 20, lifts: 9,
      note: "Gondola straight from Pozza; links to Ciampac via Col de Valvacin.", url: "https://www.fassa.com/en/ski-area/buffaure-ciampac/" },
    { name: "Catinaccio / Ciampedie", village: "Vigo di Fassa", lat: 46.4196, lng: 11.6743, top: 2150, km: 12, lifts: 7,
      note: "Sunny slopes under the Rosengarten, great views on the Vajolet towers.", url: "https://www.fassa.com/en/" },
    { name: "Ciampac", village: "Alba di Canazei", lat: 46.4677, lng: 11.7806, top: 2516, km: 15, lifts: 6,
      note: "Quiet, high-altitude snow; connected to Buffaure.", url: "https://www.fassa.com/en/ski-area/buffaure-ciampac/" },
    { name: "Belvedere – Sella Ronda", village: "Canazei", lat: 46.4762, lng: 11.7712, top: 2428, km: 60, lifts: 20,
      note: "Gateway to the famous Sella Ronda circuit (~40 km loop).", url: "https://www.sellaronda.it/" },
    { name: "Col Rodella", village: "Campitello di Fassa", lat: 46.4757, lng: 11.7441, top: 2485, km: 20, lifts: 8,
      note: "Cable car up to Col Rodella, Sella Ronda access and Sassolungo views.", url: "https://www.fassa.com/en/" },
    { name: "Carezza", village: "Passo Costalunga", lat: 46.4040, lng: 11.6110, top: 2337, km: 40, lifts: 16,
      note: "Family-friendly area with views on Latemar and Catinaccio.", url: "https://www.carezza.it/en/" },
    { name: "Alpe Lusia – San Pellegrino", village: "Moena", lat: 46.3720, lng: 11.6650, top: 2513, km: 100, lifts: 30,
      note: "Large, varied area, ski-connected to Passo San Pellegrino.", url: "https://www.skiarea.lusia-sanpellegrino.it/" },
    { name: "Marmolada", village: "Malga Ciapela", lat: 46.4277, lng: 11.9118, top: 3265, km: 12, lifts: 3,
      note: "Queen of the Dolomites — the 12 km 'La Bellunese' run from 3,265 m.", url: "https://www.funiviemarmolada.com/en/" },
  ],
};
