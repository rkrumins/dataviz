import React from "react";

interface LogoProps {
  className?: string;
}

/**
 * Neo4j "graph atom" logo — three nodes connected in a triangle
 * with a central node, using Neo4j brand blue.
 */
export const Neo4jLogo: React.FC<LogoProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    {/* Edges connecting the three outer nodes through center */}
    <line x1="12" y1="5.5" x2="6" y2="16" stroke="#018BFF" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="12" y1="5.5" x2="18" y2="16" stroke="#018BFF" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="6" y1="16" x2="18" y2="16" stroke="#018BFF" strokeWidth="1.5" strokeLinecap="round" />
    {/* Center node */}
    <circle cx="12" cy="12" r="2" fill="#018BFF" />
    {/* Edges from center to outer nodes */}
    <line x1="12" y1="12" x2="12" y2="5.5" stroke="#018BFF" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="12" y1="12" x2="6" y2="16" stroke="#018BFF" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="12" y1="12" x2="18" y2="16" stroke="#018BFF" strokeWidth="1.5" strokeLinecap="round" />
    {/* Outer nodes (drawn last so they sit on top of edges) */}
    <circle cx="12" cy="5.5" r="2.5" fill="#018BFF" />
    <circle cx="6" cy="16" r="2.5" fill="#018BFF" />
    <circle cx="18" cy="16" r="2.5" fill="#018BFF" />
  </svg>
);

/**
 * FalkorDB stylized lightning bolt in brand red.
 */
export const FalkorDBLogo: React.FC<LogoProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <path
      d="M13 2L4.5 14H12L11 22L19.5 10H12L13 2Z"
      fill="#E8292B"
      stroke="#C0201F"
      strokeWidth="0.5"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * DataHub hub-and-spoke network icon in brand green.
 */
export const DataHubLogo: React.FC<LogoProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    {/* Spokes from center to outer nodes */}
    <line x1="12" y1="12" x2="12" y2="4" stroke="#00A86B" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="12" y1="12" x2="19" y2="8" stroke="#00A86B" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="12" y1="12" x2="19" y2="16" stroke="#00A86B" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="12" y1="12" x2="12" y2="20" stroke="#00A86B" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="12" y1="12" x2="5" y2="16" stroke="#00A86B" strokeWidth="1.5" strokeLinecap="round" />
    <line x1="12" y1="12" x2="5" y2="8" stroke="#00A86B" strokeWidth="1.5" strokeLinecap="round" />
    {/* Hexagonal ring connecting outer nodes */}
    <polygon
      points="12,4 19,8 19,16 12,20 5,16 5,8"
      fill="none"
      stroke="#00A86B"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    {/* Outer nodes */}
    <circle cx="12" cy="4" r="2" fill="#00A86B" />
    <circle cx="19" cy="8" r="2" fill="#00A86B" />
    <circle cx="19" cy="16" r="2" fill="#00A86B" />
    <circle cx="12" cy="20" r="2" fill="#00A86B" />
    <circle cx="5" cy="16" r="2" fill="#00A86B" />
    <circle cx="5" cy="8" r="2" fill="#00A86B" />
    {/* Center hub */}
    <circle cx="12" cy="12" r="2.5" fill="#00A86B" />
  </svg>
);

/**
 * Mock/test beaker icon in violet.
 */
export const MockLogo: React.FC<LogoProps> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    {/* Beaker body */}
    <path
      d="M9 3H15V9L19 18C19.3 18.7 18.8 19.5 18 19.5H6C5.2 19.5 4.7 18.7 5 18L9 9V3Z"
      stroke="#7C3AED"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
    {/* Liquid fill */}
    <path
      d="M7.5 15L10 11.5L13 13.5L16.5 15H7.5Z"
      fill="#7C3AED"
      opacity="0.3"
    />
    {/* Rim */}
    <line x1="7.5" y1="3" x2="16.5" y2="3" stroke="#7C3AED" strokeWidth="1.5" strokeLinecap="round" />
    {/* Bubbles */}
    <circle cx="11" cy="16" r="0.8" fill="#7C3AED" />
    <circle cx="13.5" cy="14.5" r="0.6" fill="#7C3AED" />
  </svg>
);

/**
 * Returns the matching provider logo component for a given provider type string.
 * Falls back to MockLogo for unknown types.
 */
export function getProviderLogo(
  type: string
): React.ComponentType<{ className?: string }> {
  const key = type.toLowerCase().replace(/[\s\-_]/g, "");

  if (key.includes("neo4j")) return Neo4jLogo;
  if (key.includes("falkor")) return FalkorDBLogo;
  if (key.includes("datahub")) return DataHubLogo;

  return MockLogo;
}
