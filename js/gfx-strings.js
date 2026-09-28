// gfx-strings.js — localized strings for the Graphics settings section.
// The rest of the game is English-only; this panel follows navigator.language.

const EN = {
  heading: 'Graphics',
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})',
  adaptive: 'Adaptive resolution',
  showFps: 'Show frame rate',
  postUnavailable: 'Post-processing is unavailable on this device; rendering without it.',
  categories: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Colour grade',
    antialias: 'Anti-aliasing', particles: 'Particles', detail: 'Surface detail', water: 'Water',
  },
  tiers: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Plain', detailed: 'Detailed',
    static: 'Static', animated: 'Animated',
  },
};

const EN_US = {
  ...EN,
  categories: { ...EN.categories, grade: 'Color grade' },
};

const ES = {
  heading: 'Gráficos',
  quality: 'Calidad',
  auto: 'Automático (detectado: {tier})',
  presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderizado',
  fromPreset: 'Según el ajuste ({tier})',
  adaptive: 'Resolución adaptativa',
  showFps: 'Mostrar fotogramas por segundo',
  postUnavailable: 'El posprocesado no está disponible en este dispositivo; se renderiza sin él.',
  categories: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
    antialias: 'Suavizado de bordes', particles: 'Partículas', detail: 'Detalle de superficies', water: 'Agua',
  },
  tiers: {
    off: 'No', on: 'Sí', low: 'Baja', medium: 'Media', high: 'Alta',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Detallado',
    static: 'Estática', animated: 'Animada',
  },
};

const ES_419 = { ...ES, heading: 'Gráficas', renderScale: 'Escala de renderización' };

const DE = {
  heading: 'Grafik',
  quality: 'Qualität',
  auto: 'Automatisch (erkannt: {tier})',
  presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  renderScale: 'Renderskalierung',
  fromPreset: 'Aus Voreinstellung ({tier})',
  adaptive: 'Adaptive Auflösung',
  showFps: 'Bildrate anzeigen',
  postUnavailable: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; es wird ohne sie gerendert.',
  categories: {
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur',
    antialias: 'Kantenglättung', particles: 'Partikel', detail: 'Oberflächendetails', water: 'Wasser',
  },
  tiers: {
    off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Schlicht', detailed: 'Detailliert',
    static: 'Statisch', animated: 'Animiert',
  },
};

const FR = {
  heading: 'Graphismes',
  quality: 'Qualité',
  auto: 'Automatique (détecté : {tier})',
  presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  renderScale: 'Échelle de rendu',
  fromPreset: 'Selon le préréglage ({tier})',
  adaptive: 'Résolution adaptative',
  showFps: 'Afficher la fréquence d’images',
  postUnavailable: 'Le post-traitement n’est pas disponible sur cet appareil ; rendu sans post-traitement.',
  categories: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs',
    antialias: 'Anticrénelage', particles: 'Particules', detail: 'Détail des surfaces', water: 'Eau',
  },
  tiers: {
    off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Détaillé',
    static: 'Statique', animated: 'Animée',
  },
};

const FR_CA = { ...FR, showFps: 'Afficher le nombre d’images par seconde' };

const PT_BR = {
  heading: 'Gráficos',
  quality: 'Qualidade',
  auto: 'Automático (detectado: {tier})',
  presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderização',
  fromPreset: 'Da predefinição ({tier})',
  adaptive: 'Resolução adaptável',
  showFps: 'Mostrar taxa de quadros',
  postUnavailable: 'O pós-processamento não está disponível neste dispositivo; renderizando sem ele.',
  categories: {
    shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor',
    antialias: 'Suavização de serrilhado', particles: 'Partículas', detail: 'Detalhe das superfícies', water: 'Água',
  },
  tiers: {
    off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simples', detailed: 'Detalhado',
    static: 'Estática', animated: 'Animada',
  },
};

const IT = {
  heading: 'Grafica',
  quality: 'Qualità',
  auto: 'Automatica (rilevata: {tier})',
  presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Scala di rendering',
  fromPreset: 'Dal preset ({tier})',
  adaptive: 'Risoluzione adattiva',
  showFps: 'Mostra frequenza fotogrammi',
  postUnavailable: 'La post-elaborazione non è disponibile su questo dispositivo; rendering senza.',
  categories: {
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
    antialias: 'Antialiasing', particles: 'Particelle', detail: 'Dettaglio superfici', water: 'Acqua',
  },
  tiers: {
    off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Semplice', detailed: 'Dettagliato',
    static: 'Statica', animated: 'Animata',
  },
};

export const GFX_STRINGS = {
  'en-US': EN_US, 'en-GB': EN,
  'es-419': ES_419, 'es-ES': ES,
  'de-DE': DE,
  'fr-FR': FR, 'fr-CA': FR_CA,
  'pt-BR': PT_BR,
  'it-IT': IT,
};

/** Pick the closest supported locale for a BCP-47 tag (default en-US). */
export function gfxLocale(tag) {
  const t = String(tag || 'en-US');
  if (GFX_STRINGS[t]) return t;
  const [lang, region] = t.split('-');
  if (lang === 'en') return /^(GB|IE|AU|NZ|ZA|IN)$/i.test(region || '') ? 'en-GB' : 'en-US';
  if (lang === 'es') return /^ES$/i.test(region || '') ? 'es-ES' : 'es-419';
  if (lang === 'fr') return /^CA$/i.test(region || '') ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

export function gfxStrings(tag) {
  return GFX_STRINGS[gfxLocale(tag)];
}
