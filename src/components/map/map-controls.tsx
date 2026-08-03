import { Globe2 } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { Button } from "@/components/ui/button";

interface MapControlsProps {
  showBackToWorld: boolean;
  onBackToWorld: () => void;
  countryName?: string;
}

export function MapControls({ showBackToWorld, onBackToWorld, countryName }: MapControlsProps) {
  return (
    <div className="pointer-events-none absolute top-4 start-4 z-10">
      <AnimatePresence>
        {showBackToWorld && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="pointer-events-auto"
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={onBackToWorld}
              className="glass-card gap-2 border-0"
            >
              <Globe2 className="size-4" />
              {countryName ? `חזרה לעולם (מ${countryName})` : "חזרה לעולם"}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
