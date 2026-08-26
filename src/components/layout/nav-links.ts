import type { LucideIcon } from "lucide-react";
import { LayoutDashboard, Luggage, Map, Stamp, User } from "lucide-react";

export interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const navLinks: NavLink[] = [
  { href: "/dashboard", label: "דף הבית", icon: LayoutDashboard },
  { href: "/trips", label: "הטיולים שלי", icon: Luggage },
  { href: "/map", label: "מפה", icon: Map },
  { href: "/passport", label: "דרכון הטיולים שלי", icon: Stamp },
  { href: "/profile", label: "פרופיל הטיולים שלי", icon: User },
];
