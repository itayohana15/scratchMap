import type { LucideIcon } from "lucide-react";
import { LayoutDashboard, Luggage, Map } from "lucide-react";

export interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const navLinks: NavLink[] = [
  { href: "/dashboard", label: "לוח בקרה", icon: LayoutDashboard },
  { href: "/trips", label: "הטיולים שלי", icon: Luggage },
  { href: "/map", label: "מפה", icon: Map },
];
