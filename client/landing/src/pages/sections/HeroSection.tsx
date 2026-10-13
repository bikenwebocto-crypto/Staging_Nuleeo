import { useState, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { appUrl } from "@/lib/appUrl";
import { motion, AnimatePresence } from "framer-motion";
import { Logo } from "@ui/components/Logo";
import bg1 from "@/assets/images/bg-carousel-1.jpg";
import bg2 from "@/assets/images/bg-carousel-2.jpg";
import bg3 from "@/assets/images/bg-carousel-3.jpg";
import bg4 from "@/assets/images/bg-carousel-4.jpg";
import bg5 from "@/assets/images/bg-carousel-5.jpg";
import bg6 from "@/assets/images/bg-carousel-6.jpg";
import bg7 from "@/assets/images/bg-carousel-7.jpg";
import bg8 from "@/assets/images/bg-carousel-8.jpg";
import bg9 from "@/assets/images/bg-carousel-9.jpg";
import bg10 from "@/assets/images/bg-carousel-10.jpg";

const images = [bg1, bg2, bg3, bg4, bg5, bg6, bg7, bg8, bg9, bg10];

export default function HeroSection() {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentImageIndex((prev) => (prev + 1) % images.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="relative min-h-screen w-full flex flex-col overflow-hidden">
      {/* Background carousel */}
      <div className="absolute inset-0 z-0">
        <AnimatePresence mode="wait">
          <motion.img
            key={currentImageIndex}
            src={images[currentImageIndex]}
            alt=""
            initial={{ opacity: 0, scale: 1.05 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 2.5, ease: "easeInOut" }}
            className="absolute w-full h-full object-cover"
          />
        </AnimatePresence>
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/20 to-black/60" />
      </div>

      {/* Content */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center text-center px-6 pt-24 pb-32">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          <Logo
            variant="wordmark"
            color="white"
            alt="Olio"
            className="h-24 md:h-32 lg:h-40 w-auto mx-auto"
          />
          <h1 className="text-white/80 text-xl md:text-2xl font-medium mt-6">
            Your real estate wallet
          </h1>
        </motion.div>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.5 }}
          className="text-white/70 text-base md:text-lg max-w-xl mt-6 leading-relaxed"
        >
          Manage properties, track rent, and grow your portfolio — all in one place.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.8 }}
          className="flex flex-col sm:flex-row gap-3 mt-10"
        >
          <button
            onClick={() => window.location.assign(appUrl("/auth"))}
            className="px-8 py-4 bg-white text-black font-semibold text-lg rounded-full hover:bg-white/90 active:scale-[0.98] transition-all shadow-lg"
          >
            Get Started
          </button>
          <button
            onClick={() =>
              document.querySelector("#features")?.scrollIntoView({ behavior: "smooth" })
            }
            className="px-8 py-4 bg-white/10 backdrop-blur-md text-white font-semibold text-lg rounded-full border border-white/20 hover:bg-white/20 active:scale-[0.98] transition-all"
          >
            Learn More
          </button>
        </motion.div>
      </div>

      {/* Scroll indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5 }}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10"
      >
        <motion.div
          animate={{ y: [0, 8, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <ChevronDown size={28} className="text-white/50" />
        </motion.div>
      </motion.div>

      {/* Image indicators */}
      <div className="absolute bottom-8 right-6 z-10 hidden md:flex gap-1.5">
        {images.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setCurrentImageIndex(i)}
            aria-label={`Show image ${i + 1} of ${images.length}`}
            aria-current={i === currentImageIndex ? "true" : undefined}
            className={`w-1.5 h-1.5 rounded-full transition-all duration-500 ${
              i === currentImageIndex ? "bg-white w-4" : "bg-white/40"
            }`}
          />
        ))}
      </div>
    </section>
  );
}
