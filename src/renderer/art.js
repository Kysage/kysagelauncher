/* Отрисовка всей графики лаунчера: сцена, кубы, аватары. Никаких внешних картинок. */
(() => {
  'use strict';

  function rng(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function stars() {
    const random = rng(20261120);
    let out = '';
    for (let i = 0; i < 74; i++) {
      const x = Math.round(random() * 1190);
      const y = Math.round(random() * 340);
      const big = random() > 0.82;
      const size = big ? 3 : 2;
      const color = random() > 0.8 ? '#ffe6c4' : random() > 0.5 ? '#cfe3ff' : '#9fb6d8';
      const opacity = (0.35 + random() * 0.6).toFixed(2);
      out += `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${color}" opacity="${opacity}"/>`;
    }
    return out;
  }

  function cloud(x, y, scale, opacity) {
    return `<g transform="translate(${x} ${y}) scale(${scale})" fill="#9b7599" opacity="${opacity}">
      <rect x="0" y="14" width="92" height="12" rx="0"/>
      <rect x="16" y="4" width="56" height="12"/>
      <rect x="48" y="0" width="34" height="10"/>
      <rect x="74" y="10" width="42" height="10"/>
      <rect x="30" y="26" width="70" height="8" opacity=".7"/>
    </g>`;
  }

  function pine(x, y, height, color) {
    const u = Math.max(2, Math.round(height / 9));
    return `<g fill="${color}">
      <rect x="${x - u}" y="${y - u * 2}" width="${u * 2}" height="${u * 2}"/>
      <rect x="${x - u * 2}" y="${y - u * 3}" width="${u * 4}" height="${u * 1.6}"/>
      <rect x="${x - u * 1.6}" y="${y - u * 4.6}" width="${u * 3.2}" height="${u * 1.6}"/>
      <rect x="${x - u * 1.1}" y="${y - u * 6.2}" width="${u * 2.2}" height="${u * 1.6}"/>
      <rect x="${x - u * 0.7}" y="${y - u * 7.6}" width="${u * 1.4}" height="${u * 1.5}"/>
      <rect x="${x - u * 0.35}" y="${y - u * 0.6}" width="${u * 0.7}" height="${u * 1.2}" opacity=".7"/>
    </g>`;
  }

  function island(x, y, scale) {
    return `<g transform="translate(${x} ${y}) scale(${scale})">
      <polygon points="4,10 32,24 32,34 12,24 8,18" fill="#2c211b"/>
      <polygon points="60,10 32,24 32,34 52,24 56,18" fill="#1d1714"/>
      <polygon points="18,18 32,26 32,40 22,32" fill="#34261e"/>
      <polygon points="46,18 32,26 32,38 42,31" fill="#241a15"/>
      <polygon points="0,0 32,16 64,0 32,-16" fill="#7ab55c"/>
      <polygon points="0,0 32,16 32,23 0,7" fill="#4d7c3e"/>
      <polygon points="64,0 32,16 32,23 64,7" fill="#3f6634"/>
      <rect x="12" y="2" width="7" height="4" fill="#8fc76b"/>
      <rect x="40" y="-6" width="9" height="4" fill="#679c50"/>
      <rect x="27" y="-13" width="6" height="4" fill="#8fc76b"/>
      <rect x="7" y="12" width="3" height="14" fill="#3f6634"/>
      <rect x="23" y="16" width="3" height="20" fill="#41683a"/>
      <rect x="44" y="13" width="3" height="12" fill="#35552f"/>
      <rect x="52" y="9" width="3" height="18" fill="#3b5f34"/>
      <rect x="18" y="12" width="4" height="3" fill="#5c4633"/>
      <rect x="38" y="10" width="5" height="3" fill="#4a382a"/>
      <rect x="32" y="28" width="4" height="4" fill="#33241c"/>
      <rect x="22" y="24" width="3" height="3" fill="#3d2b21"/>
      <rect x="42" y="22" width="3" height="3" fill="#2a1e18"/>
    </g>`;
  }

  function torch(x, y) {
    return `<g>
      <ellipse cx="${x}" cy="${y + 2}" rx="26" ry="18" fill="url(#torchGlow)"/>
      <rect x="${x - 2}" y="${y - 18}" width="4" height="20" fill="#3a2a1e"/>
      <rect x="${x - 3}" y="${y - 24}" width="6" height="7" fill="#ffd27d"/>
      <rect x="${x - 1}" y="${y - 28}" width="2" height="5" fill="#fff1c9"/>
    </g>`;
  }

  function scene() {
    return `<svg class="scene" viewBox="0 0 1200 640" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#04060e"/>
          <stop offset="0.22" stop-color="#0a1022"/>
          <stop offset="0.42" stop-color="#1a1a38"/>
          <stop offset="0.58" stop-color="#3c2749"/>
          <stop offset="0.72" stop-color="#7d3b52"/>
          <stop offset="0.84" stop-color="#d06f4d"/>
          <stop offset="0.92" stop-color="#f8a563"/>
          <stop offset="1" stop-color="#ffd39a"/>
        </linearGradient>
        <radialGradient id="sunGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="#ffd49a" stop-opacity="0.75"/>
          <stop offset="0.36" stop-color="#ff9d63" stop-opacity="0.34"/>
          <stop offset="1" stop-color="#ff8a55" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="sunCore" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff3d0"/>
          <stop offset="0.5" stop-color="#ffd492"/>
          <stop offset="1" stop-color="#ff9f5e"/>
        </linearGradient>
        <linearGradient id="hazeGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffb078" stop-opacity="0"/>
          <stop offset="0.6" stop-color="#ff9f6b" stop-opacity="0.22"/>
          <stop offset="1" stop-color="#ff8f5e" stop-opacity="0"/>
        </linearGradient>
        <radialGradient id="torchGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="#ffd089" stop-opacity="0.55"/>
          <stop offset="1" stop-color="#ff9d4f" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="ridgeGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#1b2f26"/>
          <stop offset="0.35" stop-color="#0d1817"/>
          <stop offset="1" stop-color="#05090c"/>
        </linearGradient>
      </defs>

      <rect width="1200" height="640" fill="url(#skyGrad)"/>
      <g class="art-stars">${stars()}</g>
      <g class="art-clouds">
        ${cloud(80, 150, 0.9, 0.16)}
        ${cloud(430, 96, 0.7, 0.12)}
        ${cloud(880, 118, 1.15, 0.14)}
        ${cloud(1010, 210, 0.8, 0.1)}
      </g>

      <circle cx="884" cy="368" r="330" fill="url(#sunGlow)"/>
      <circle cx="884" cy="368" r="70" fill="url(#sunCore)"/>
      <rect x="770" y="352" width="228" height="9" fill="#ffcf95" opacity="0.3"/>
      <rect x="812" y="392" width="150" height="5" fill="#ffc489" opacity="0.24"/>
      <rect x="742" y="404" width="290" height="3" fill="#ffbe86" opacity="0.16"/>

      <g class="art-far">
        <path d="M0 424 L0 402 L72 402 L72 374 L132 374 L132 352 L188 352 L188 340 L242 340 L242 362 L302 362 L302 324 L362 324 L362 350 L420 350 L420 310 L472 310 L472 334 L522 334 L522 364 L582 364 L582 344 L642 344 L642 370 L702 370 L702 330 L762 330 L762 354 L822 354 L822 326 L880 326 L880 358 L942 358 L942 342 L1012 342 L1012 366 L1082 366 L1082 346 L1140 346 L1140 372 L1200 372 L1200 640 L0 640 Z" fill="#38305c"/>
        <path d="M0 424 L0 402 L72 402 L72 374 L132 374 L132 352 L188 352 L188 340 L242 340 L242 362 L302 362 L302 324 L362 324 L362 350 L420 350 L420 310 L472 310 L472 334 L522 334 L522 364 L582 364 L582 344 L642 344 L642 370 L702 370 L702 330 L762 330 L762 354 L822 354 L822 326 L880 326 L880 358 L942 358 L942 342 L1012 342 L1012 366 L1082 366 L1082 346 L1140 346 L1140 372 L1200 372" fill="none" stroke="#5b4d8c" stroke-width="1.5" opacity="0.65"/>
      </g>

      <rect x="0" y="300" width="1200" height="160" fill="url(#hazeGrad)"/>

      <g class="art-mid">
        <path d="M0 470 L0 440 L56 440 L56 414 L118 414 L118 432 L176 432 L176 398 L238 398 L238 422 L300 422 L300 400 L356 400 L356 430 L418 430 L418 406 L478 406 L478 434 L548 434 L548 410 L610 410 L610 438 L676 438 L676 404 L734 404 L734 428 L800 428 L800 398 L862 398 L862 426 L924 426 L924 408 L992 408 L992 436 L1058 436 L1058 416 L1128 416 L1128 442 L1200 442 L1200 640 L0 640 Z" fill="#242140"/>
        <path d="M0 470 L0 440 L56 440 L56 414 L118 414 L118 432 L176 432 L176 398 L238 398 L238 422 L300 422 L300 400 L356 400 L356 430 L418 430 L418 406 L478 406 L478 434 L548 434 L548 410 L610 410 L610 438 L676 438 L676 404 L734 404 L734 428 L800 428 L800 398 L862 398 L862 426 L924 426 L924 408 L992 408 L992 436 L1058 436 L1058 416 L1128 416 L1128 442 L1200 442" fill="none" stroke="#3a3560" stroke-width="1.5" opacity="0.6"/>
        ${pine(930, 452, 34, '#171530')}
        ${pine(972, 460, 26, '#171530')}
        ${pine(660, 448, 24, '#171530')}
      </g>

      <g class="art-float">
        ${island(634, 268, 1.55)}
        ${island(1018, 190, 1.05)}
        ${island(872, 330, 0.62)}
        ${island(486, 158, 0.52)}
        ${island(1152, 322, 0.46)}
      </g>

      <g class="art-hills">
        <path d="M0 540 L0 512 L84 512 L84 494 L168 494 L168 510 L252 510 L252 492 L340 492 L340 516 L424 516 L424 500 L516 500 L516 522 L608 522 L608 506 L700 506 L700 526 L796 526 L796 508 L886 508 L886 528 L980 528 L980 512 L1070 512 L1070 532 L1140 532 L1140 520 L1200 520 L1200 640 L0 640 Z" fill="#111d2f"/>
        <path d="M0 540 L0 512 L84 512 L84 494 L168 494 L168 510 L252 510 L252 492 L340 492 L340 516 L424 516 L424 500 L516 500 L516 522 L608 522 L608 506 L700 506 L700 526 L796 526 L796 508 L886 508 L886 528 L980 528 L980 512 L1070 512 L1070 532 L1140 532 L1140 520 L1200 520" fill="none" stroke="#2c5a3f" stroke-width="1.5" opacity="0.55"/>
        ${pine(196, 516, 42, '#0a1420')}
        ${pine(240, 522, 30, '#0a1420')}
        ${pine(760, 538, 36, '#0a1420')}
        ${pine(1110, 540, 54, '#0a1420')}
        ${pine(1148, 548, 38, '#0a1420')}
      </g>

      <g class="art-front">
        <path d="M0 640 L0 592 L64 592 L64 578 L150 578 L150 590 L236 590 L236 574 L330 574 L330 588 L420 588 L420 572 L512 572 L512 586 L610 586 L610 570 L712 570 L712 584 L810 584 L810 568 L910 568 L910 582 L1010 582 L1010 566 L1104 566 L1104 580 L1200 580 L1200 640 Z" fill="url(#ridgeGrad)"/>
        <path d="M0 592 L64 592 L64 578 L150 578 L150 590 L236 590 L236 574 L330 574 L330 588 L420 588 L420 572 L512 572 L512 586 L610 586 L610 570 L712 570 L712 584 L810 584 L810 568 L910 568 L910 582 L1010 582 L1010 566 L1104 566 L1104 580 L1200 580" fill="none" stroke="#4b9449" stroke-width="4"/>
        <path d="M0 592 L64 592 L64 578 L150 578 L150 590 L236 590 L236 574 L330 574 L330 588 L420 588 L420 572 L512 572 L512 586 L610 586 L610 570 L712 570 L712 584 L810 584 L810 568 L910 568 L910 582 L1010 582 L1010 566 L1104 566 L1104 580 L1200 580" fill="none" stroke="#8bd676" stroke-width="1.4" opacity="0.55"/>
        <rect x="118" y="598" width="26" height="14" fill="#101a15"/>
        <rect x="118" y="596" width="26" height="4" fill="#4f9247"/>
        <rect x="300" y="594" width="34" height="12" fill="#0e1713"/>
        <rect x="300" y="592" width="34" height="4" fill="#3f7a3c"/>
        <rect x="866" y="590" width="30" height="14" fill="#101a15"/>
        <rect x="866" y="588" width="30" height="4" fill="#4f9247"/>
        <rect x="1038" y="588" width="22" height="12" fill="#0e1713"/>
        <rect x="1038" y="586" width="22" height="4" fill="#447f3f"/>
        <rect x="196" y="590" width="3" height="7" fill="#3c7a41"/>
        <rect x="206" y="592" width="3" height="5" fill="#356d3a"/>
        <rect x="742" y="580" width="3" height="7" fill="#3c7a41"/>
        <rect x="948" y="578" width="3" height="8" fill="#4a8b47"/>
        <rect x="958" y="580" width="3" height="6" fill="#3c7a41"/>
        ${torch(214, 604)}
        ${torch(986, 598)}
      </g>
    </svg>`;
  }

  function cube(size = 40) {
    return `<svg class="cube" width="${size}" height="${Math.round(size * 1.06)}" viewBox="0 0 32 34" aria-hidden="true">
      <polygon points="16,1 31,8.5 16,16 1,8.5" fill="#7fd35b"/>
      <polygon points="1,8.5 16,16 16,33 1,25.5" fill="#6b4b35"/>
      <polygon points="31,8.5 16,16 16,33 31,25.5" fill="#4a3326"/>
      <polygon points="1,8.5 16,16 16,20.5 1,13" fill="#4f9c3e"/>
      <polygon points="31,8.5 16,16 16,20.5 31,13" fill="#3f7f34"/>
      <rect x="5" y="16" width="4" height="3" fill="#7d5a40"/>
      <rect x="9" y="23" width="4" height="4" fill="#553c2b"/>
      <rect x="20" y="20" width="5" height="4" fill="#38261d"/>
      <rect x="24" y="26" width="4" height="3" fill="#5b402e"/>
      <rect x="11" y="5" width="5" height="3" fill="#96e06f"/>
      <rect x="20" y="8" width="4" height="3" fill="#65b34a"/>
    </svg>`;
  }

  function logo(size = 34) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
      <polygon points="16,2 30,9 16,16 2,9" fill="#9bf474"/>
      <polygon points="2,9 16,16 16,29 2,22" fill="#2b323d"/>
      <polygon points="30,9 16,16 16,29 30,22" fill="#161b23"/>
      <polygon points="2,9 16,16 16,19 2,12" fill="#5fd94c" opacity="0.55"/>
      <rect x="6" y="15" width="3" height="3" fill="#4fe04a"/>
      <rect x="22" y="18" width="2" height="2" fill="#9bf474" opacity="0.7"/>
      <path d="M2 9 L16 2 L30 9" fill="none" stroke="#d3ffbc" stroke-width="0.8" opacity="0.5"/>
    </svg>`;
  }

  const SKINS = [
    { skin: '#c9956b', shade: '#a97a53', hair: '#39281b', eye: '#22313f', bg: '#26201a' },
    { skin: '#e0b183', shade: '#bd8a5c', hair: '#5a3520', eye: '#26323d', bg: '#2b2119' },
    { skin: '#a9754f', shade: '#8b5c3c', hair: '#1d1512', eye: '#1c262f', bg: '#1f1a16' },
    { skin: '#f0c99c', shade: '#cf9f70', hair: '#c9973f', eye: '#2b3a48', bg: '#2d251b' },
    { skin: '#8b5e3c', shade: '#6f452b', hair: '#2b1c14', eye: '#e8d9bd', bg: '#211b16' },
    { skin: '#d9a978', shade: '#b98756', hair: '#7a2f2a', eye: '#1e2a33', bg: '#2a1f1b' },
    { skin: '#bb8a63', shade: '#9a6c48', hair: '#d8d3c8', eye: '#2a3540', bg: '#232120' },
    { skin: '#e6bd90', shade: '#c49667', hair: '#3e4f62', eye: '#1d2831', bg: '#1e2329' }
  ];

  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function avatar(nickname = 'Steve', size = 48) {
    const name = String(nickname || 'Steve') || 'Steve';
    const h = hash(name.toLowerCase());
    const skin = SKINS[h % SKINS.length];
    const cells = [];
    const fill = (x, y, color) => cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`);

    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) fill(x, y, skin.skin);
    }

    // волосы: верх + рваная чёлка
    for (let x = 0; x < 8; x++) {
      fill(x, 0, skin.hair);
      fill(x, 1, skin.hair);
    }
    for (let x = 0; x < 8; x++) {
      if ((h >> (x % 16)) & 1) fill(x, 2, skin.hair);
    }
    fill(0, 2, skin.hair);
    fill(7, 2, skin.hair);
    fill(0, 3, skin.hair);
    fill(7, 3, skin.hair);

    // глаза и брови
    fill(2, 3, skin.shade);
    fill(5, 3, skin.shade);
    fill(2, 4, skin.eye);
    fill(5, 4, skin.eye);
    if (h % 3 === 0) {
      fill(1, 4, skin.shade);
      fill(6, 4, skin.shade);
    }

    // нос и рот
    fill(4, 5, skin.shade);
    fill(3, 6, skin.shade);
    fill(4, 6, skin.shade);

    // тени по краям
    fill(1, 5, skin.shade);
    fill(6, 5, skin.shade);
    fill(2, 7, skin.shade);
    fill(5, 7, skin.shade);

    return `<svg class="skin" width="${size}" height="${size}" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">
      <rect width="8" height="8" fill="${skin.bg}"/>
      ${cells.join('')}
    </svg>`;
  }

  window.LauncherArt = { scene, cube, logo, avatar };
})();
