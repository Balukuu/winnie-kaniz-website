// ── Airbnb Availability & Pricing Checker ────────────────────────────────────
const AIRBNB_LISTINGS = {
    classic:   '1542437708058109816',
    premier:   '1674038645436000786',
    executive: '1674021824983862337',
    sanctuary: '1666180399004248477',
};

// Paste the .ics export URL from Airbnb host dashboard → Calendar → Export Calendar
const AIRBNB_ICAL = {
    classic:   '',
    premier:   '',
    executive: '',
    sanctuary: '',
};

// ── YOUR ACTUAL AIRBNB NIGHTLY RATES ─────────────────────────────────────────
// Update these to match exactly what Airbnb shows on each listing.
// These are shown directly — no "estimated" label.
const NIGHTLY_RATES = {
    classic:   150000,   // UGX — The Classic Suite
    premier:   220000,   // UGX — The Premier Residence
    executive: 280000,   // UGX — The Executive Retreat
    sanctuary: 120000,   // UGX — The Urban Sanctuary (fallback; live Airbnb price overrides)
};
const CURRENCY = 'UGX';

const CORS_PROXY = 'https://corsproxy.io/?url=';

// ── iCal helpers ─────────────────────────────────────────────────────────────
function parseIcalBusy(icsText) {
    const busy = [];
    const lines = icsText.replace(/\r\n/g, '\n').split('\n');
    let inEvent = false, dtStart = null, dtEnd = null;
    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') { inEvent = true; dtStart = dtEnd = null; }
        if (!inEvent) continue;
        const val = l => l.includes(':') ? l.split(':').slice(1).join(':').trim().slice(0, 8) : null;
        if (line.startsWith('DTSTART')) dtStart = val(line);
        if (line.startsWith('DTEND'))   dtEnd   = val(line);
        if (line === 'END:VEVENT' && dtStart && dtEnd) {
            busy.push({ start: dtStart, end: dtEnd });
            inEvent = false;
        }
    }
    return busy;
}

function toCompact(dateStr) { return dateStr.replace(/-/g, ''); }

function datesAvailable(busy, checkIn, checkOut) {
    const cin = toCompact(checkIn), cout = toCompact(checkOut);
    return !busy.some(({ start, end }) => start < cout && end > cin);
}

// ── Airbnb live price fetch — tries to read the __NEXT_DATA__ JSON ────────────
async function fetchLiveAirbnbPrice(listingId, checkIn, checkOut) {
    const url = `https://www.airbnb.com/rooms/${listingId}?check_in=${checkIn}&check_out=${checkOut}&adults=1`;
    const res  = await fetch(CORS_PROXY + encodeURIComponent(url));
    const html = await res.text();

    // Strategy 1: parse __NEXT_DATA__ embedded JSON
    const ndMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (ndMatch) {
        try {
            const nd = JSON.parse(ndMatch[1]);
            // Walk the sections looking for price data
            const sections = nd?.props?.pageProps?.sections?.sections
                          ?? nd?.props?.pageProps?.bootstrapData?.reduxData?.homePDP?.sbuiData?.sectionConfiguration?.root?.sections
                          ?? [];
            for (const sec of sections) {
                const raw = JSON.stringify(sec);
                // Look for per-night price pattern in any section
                const m = raw.match(/"displayPrice":\s*"([^"]+)"|"price":\s*\{\s*"amount":\s*([\d.]+).*?"currency":\s*"([^"]+)"/);
                if (m) {
                    const amount   = m[1] || m[2];
                    const currency = m[3] || CURRENCY;
                    return { perNight: parseFloat(amount.replace(/[^\d.]/g, '')), currency };
                }
            }
        } catch { /* fall through */ }
    }

    // Strategy 2: match price pattern directly in the raw HTML
    const patterns = [
        /"amount":([\d.]+),"amountFormatted":"[^"]*","currency":"([^"]+)"/,
        /"originalPrice":\{"amount":([\d.]+),"currency":"([^"]+)"\}/,
        /\"price_string\":\"([^\s"]+)\s+([A-Z]+)/,
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) return { perNight: parseFloat(m[1].replace(/[^\d.]/g, '')), currency: m[2] || CURRENCY };
    }

    return null; // could not parse — caller will use configured rate
}

// ── Night count ───────────────────────────────────────────────────────────────
function nightsBetween(checkIn, checkOut) {
    return Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setLoading(on) {
    document.getElementById('availBtnText').style.display    = on ? 'none'   : '';
    document.getElementById('availBtnSpinner').style.display = on ? 'inline' : 'none';
    document.getElementById('availBtn').disabled = on;
}

function showResult({ available, nights, perNight, currency, livePrice, listingId, checkIn, checkOut }) {
    const card     = document.getElementById('availResult');
    const statusEl = document.getElementById('availStatus');
    const priceEl  = document.getElementById('availPricing');
    const bookBtn  = document.getElementById('availBookBtn');

    card.style.display = 'flex';

    if (!available) {
        statusEl.className = 'avail-status unavailable';
        statusEl.innerHTML = '✗ &nbsp;Not available for these dates';
        priceEl.innerHTML  = 'Please try different dates or contact us directly.';
        bookBtn.style.display = 'none';
        return;
    }

    statusEl.className = 'avail-status available';
    statusEl.innerHTML = '✓ &nbsp;Available!';

    const total      = perNight * nights;
    const nightLabel = `${nights} night${nights !== 1 ? 's' : ''}`;
    const source     = livePrice
        ? '<span style="font-size:0.8rem;color:#aaa;">Live price from Airbnb · taxes may apply</span>'
        : '<span style="font-size:0.8rem;color:#aaa;">Price per your Airbnb listing · taxes may apply</span>';

    priceEl.innerHTML = `
        <strong>${currency} ${total.toLocaleString()}</strong> total
        &nbsp;·&nbsp; ${currency} ${perNight.toLocaleString()} × ${nightLabel}
        <br>${source}`;

    const airbnbUrl = `https://www.airbnb.com/rooms/${listingId}?check_in=${checkIn}&check_out=${checkOut}`;
    bookBtn.href = airbnbUrl;
    bookBtn.style.display = 'inline-flex';
}

// ── Main check ────────────────────────────────────────────────────────────────
async function checkAvailability(apartment, checkIn, checkOut) {
    document.getElementById('availResult').style.display = 'none';

    if (!checkIn || !checkOut) { alert('Please select both check-in and check-out dates.'); return; }
    if (checkIn >= checkOut)   { alert('Check-out date must be after check-in date.'); return; }

    setLoading(true);

    const listingId    = AIRBNB_LISTINGS[apartment];
    const icalUrl      = AIRBNB_ICAL[apartment];
    const configRate   = NIGHTLY_RATES[apartment];
    const nights       = nightsBetween(checkIn, checkOut);

    let available  = true;
    let perNight   = configRate;
    let currency   = CURRENCY;
    let livePrice  = false;

    // 1. Check availability via iCal (if URL configured)
    if (icalUrl) {
        try {
            const icsText = await (await fetch(CORS_PROXY + encodeURIComponent(icalUrl))).text();
            available = datesAvailable(parseIcalBusy(icsText), checkIn, checkOut);
        } catch { /* network error — assume available */ }
    }

    // 2. Try fetching live price from Airbnb
    if (available) {
        try {
            const live = await fetchLiveAirbnbPrice(listingId, checkIn, checkOut);
            if (live && live.perNight > 0) {
                perNight  = live.perNight;
                currency  = live.currency || CURRENCY;
                livePrice = true;
            }
        } catch { /* use configured rate */ }
    }

    setLoading(false);
    showResult({ available, nights, perNight, currency, livePrice, listingId, checkIn, checkOut });
}
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Sticky Header with logo swap
    const header = document.querySelector('header');
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            header.classList.add('scrolled');
        } else {
            header.classList.remove('scrolled');
        }
    });

    // Mobile Menu Toggle
    const mobileToggle = document.getElementById('mobileToggle');
    const nav = document.querySelector('nav');
    
    if (mobileToggle) {
        mobileToggle.addEventListener('click', () => {
            nav.classList.toggle('mobile-active');
        });
        
        // Close mobile menu when a link is clicked
        nav.querySelectorAll('.nav-links a').forEach(link => {
            link.addEventListener('click', () => {
                nav.classList.remove('mobile-active');
            });
        });
    }

    // AOS Animation Initialization
    if (typeof AOS !== 'undefined') {
        AOS.init({
            duration: 700,
            easing: 'ease-out',
            once: true,
            mirror: false,
            offset: 80
        });
    }

    // GLightbox Initialization
    if (typeof GLightbox !== 'undefined') {
        const lightbox = GLightbox({
            selector: '.glightbox'
        });
    }

    // Swiper Initialization for Apartment Pages
    if (typeof Swiper !== 'undefined') {
        const swiper = new Swiper('.apt-swiper', {
            loop: true,
            pagination: {
                el: '.swiper-pagination',
                clickable: true,
            },
            navigation: {
                nextEl: '.swiper-button-next',
                prevEl: '.swiper-button-prev',
            },
            autoplay: {
                delay: 5000,
            },
        });
    }

    // Stats Counter Animation
    const stats = document.querySelectorAll('.stat-item h3');
    const observerOptions = {
        threshold: 0.5
    };

    const statsObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const target = entry.target;
                const endValue = parseInt(target.getAttribute('data-target'));
                if (!isNaN(endValue)) {
                    animateValue(target, 0, endValue, 2000);
                }
                observer.unobserve(target);
            }
        });
    }, observerOptions);

    stats.forEach(stat => statsObserver.observe(stat));

    function animateValue(obj, start, end, duration) {
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            obj.innerHTML = Math.floor(progress * (end - start) + start);
            if (progress < 1) {
                window.requestAnimationFrame(step);
            }
        };
        window.requestAnimationFrame(step);
    }

    // Availability form — set default dates then wire submit
    const checkInEl  = document.getElementById('checkIn');
    const checkOutEl = document.getElementById('checkOut');
    if (checkInEl && checkOutEl) {
        const today = new Date();
        const fmt = d => d.toISOString().split('T')[0];
        const twoDaysLater = new Date(today); twoDaysLater.setDate(today.getDate() + 2);
        checkInEl.value  = fmt(today);
        checkOutEl.value = fmt(twoDaysLater);
        checkInEl.min    = fmt(today);
        checkInEl.addEventListener('change', () => {
            const nextDay = new Date(checkInEl.value);
            nextDay.setDate(nextDay.getDate() + 1);
            checkOutEl.min   = fmt(nextDay);
            if (checkOutEl.value <= checkInEl.value) checkOutEl.value = fmt(nextDay);
        });
    }

    // Keep "Book Now" nav button in sync with selected apartment
    const apartmentSelect = document.getElementById('apartmentSelect');
    const navBookBtn      = document.getElementById('navBookBtn');

    function syncBookBtn() {
        if (!navBookBtn || !apartmentSelect) return;
        const key = apartmentSelect.value;
        navBookBtn.setAttribute('href', `https://www.airbnb.com/rooms/${AIRBNB_LISTINGS[key]}`);
    }

    if (apartmentSelect) apartmentSelect.addEventListener('change', syncBookBtn);
    syncBookBtn();

    const availForm = document.getElementById('availabilityForm');
    if (availForm) {
        availForm.addEventListener('submit', e => {
            e.preventDefault();
            const apartment = document.getElementById('apartmentSelect').value;
            const checkIn   = document.getElementById('checkIn').value;
            const checkOut  = document.getElementById('checkOut').value;
            checkAvailability(apartment, checkIn, checkOut);
        });
    }

    // Contact form → WhatsApp
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
        contactForm.addEventListener('submit', e => {
            e.preventDefault();
            const name = document.getElementById('contactName').value.trim();
            const apt  = document.getElementById('contactApt').value;
            const msg  = document.getElementById('contactMsg').value.trim();
            if (!name || !msg) return;
            const text = encodeURIComponent(`Hi, I'm ${name}.\nApartment interest: ${apt}\n\n${msg}`);
            window.open(`https://wa.me/256788661755?text=${text}`, '_blank', 'noopener');
        });
    }

    // Gallery filter tabs
    const filterBtns = document.querySelectorAll('.gallery-filter-btn');
    const galleryItems = document.querySelectorAll('.gallery-item[data-apt]');
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const filter = btn.dataset.filter;
            galleryItems.forEach(item => {
                const match = filter === 'all' || item.dataset.apt === filter;
                item.classList.toggle('hidden', !match);
            });
        });
    });

    // Smooth Scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const targetId = this.getAttribute('href');
            if (!targetId || !targetId.startsWith('#')) return;
            e.preventDefault();
            if (targetId === '#') return;
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                window.scrollTo({
                    top: targetElement.offsetTop - 80,
                    behavior: 'smooth'
                });
            }
        });
    });
});
