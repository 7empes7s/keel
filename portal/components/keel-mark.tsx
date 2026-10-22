// The KEEL mark: a sailboat in side profile, sails above and the fin keel and rudder
// beneath the waterline.
//
// It also carries the brand's one looping motion (styles in globals.css, "Brand mark"):
// a storm builds, the boat rolls and heaves on the swell in the rain, the keel rights
// it, the sea calms and the plain mark holds before the loop starts again. Only
// transform and opacity move. At rest (no animation, or reduced motion) every storm
// layer is hidden and the sea is flat, so the static mark is the logo.
//
// Rotation and heave pivot on (0,0) of a translated group, which every browser
// agrees on, so the boat turns around its waterline and never wobbles off-centre.
export function KeelMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className ? `keel-mark ${className}` : "keel-mark"} viewBox="-7 -7 46 46">
      <rect className="keel-gloom" height="46" width="46" x="-7" y="-7" />
      <rect className="keel-flash" height="46" width="46" x="-7" y="-7" />
      <path className="keel-bolt" d="M33.5-5l-3.4 6h2.8l-2.6 5.6 5.4-7h-2.9l2.3-4.6Z" />
      <g className="keel-rain">
        <path
          className="keel-rain-fall"
          d="M-14.3 17.8l-1.1 2.8M-11.5 28.8l-1.4 3.5M-6.8 18.4l-1.4 3.5M-2 31.4l-1.4 3.6M4.2 20.6l-1.1 2.8M7.1 32.8l-1.3 3.2M10.9 22.9l-1 2.6M16.8 33.8l-1.1 2.8M20.2 24.2l-1.3 3.2M25.2 36.9l-1.2 2.9M30.2 24.9l-1 2.5M33.3 39l-1 2.5M38.8 27.9l-1.4 3.6M-5.1-5.2l-1.1 2.8M-2.3 5.8l-1.4 3.5M2.4-4.6l-1.4 3.5M7.2 8.4l-1.4 3.6M13.4-2.4l-1.1 2.8M16.3 9.8l-1.3 3.2M20.1-.1l-1 2.6M26 10.8l-1.1 2.8M29.4 1.2l-1.3 3.2M34.4 13.9l-1.2 2.9M39.4 1.9l-1 2.5M42.5 16l-1 2.5M48 4.9l-1.4 3.6M4.1-28.2l-1.1 2.8M6.9-17.2l-1.4 3.5M11.6-27.6l-1.4 3.5M16.4-14.6l-1.4 3.6M22.6-25.4l-1.1 2.8M25.5-13.2l-1.3 3.2M29.3-23.1l-1 2.6M35.2-12.2l-1.1 2.8M38.6-21.8l-1.3 3.2M43.6-9.1l-1.2 2.9M48.6-21.1l-1 2.5M51.7-7l-1 2.5M57.2-18.1l-1.4 3.6"
        />
      </g>
      <g transform="translate(16 15)">
        <g className="keel-heave">
          <g className="keel-roll">
            <g transform="translate(-16 -15)">
              <path className="keel-sail" d="M15.2 1.8v8.4h8.6Z" />
              <path className="keel-sail keel-jib" d="M13.9 3.6v6.6H8.2Z" />
              <path className="keel-hull" d="M2.5 11.6h27l-2.4 3.4c-.8 1.2-2.2 1.9-3.7 1.9H8.7c-3.1 0-5.2-1.6-6.2-5.3Z" />
              <path className="keel-fin" d="M12.6 16.6h5.2l-1.6 8.3h-2.4Z" />
              <path className="keel-fin" d="M11.7 24.5h6.4a1.4 1.4 0 0 1 0 2.8h-6.4a1.4 1.4 0 0 1 0-2.8Z" />
              <path className="keel-fin" d="M5.6 16.4h2l-.5 4.6H6.1Z" />
            </g>
          </g>
        </g>
      </g>
      <g transform="translate(0 15)">
        <g className="keel-sea">
          <g className="keel-swell">
            <path className="keel-water" d="M-23 0q4-5 8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0V200H-23Z" />
            <path className="keel-crest" d="M-23 0q4-5 8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0t8 0" />
          </g>
        </g>
      </g>
    </svg>
  );
}
