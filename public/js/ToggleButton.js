export default class ToggleButton {
    constructor(options = {}) {
        this.size = options.size || 50;
        // Scale the SVG icon relative to the button size.
        // Default is intentionally < 1 so the glyph has comfortable padding.
        this.iconScale = (typeof options.iconScale === 'number' && isFinite(options.iconScale))
            ? Math.max(0.1, Math.min(1, options.iconScale))
            : 0.62;
        this.svgUrl = options.svgUrl || 'link.svg';
        this.colorOff = options.colorOff || '#888';
        this.colorOn = options.colorOn || '#4CAF50';
        this.checked = options.checked || false;
        this.onChange = options.onChange || null;
        
        this.element = null;
        this.input = null;
        this.svgContainer = null;
        this.svgElement = null;
        
        // Load SVG asynchronously
        this.loadSVG();
    }
    
    async loadSVG() {
        try {
            const response = await fetch(this.svgUrl);
            const svgText = await response.text();
            
            // Parse SVG
            const parser = new DOMParser();
            const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');
            this.svgElement = svgDoc.documentElement;
            
            // Create the button structure
            this.element = this.create();
            this.input = this.element.querySelector('input');
            this.svgContainer = this.element.querySelector('.svg-container');
            
            // Insert SVG into container
            this.svgContainer.appendChild(this.svgElement);
            
            // Set SVG size
            const iconPx = Math.max(1, Math.round(this.size * this.iconScale));
            this.svgElement.setAttribute('width', iconPx);
            this.svgElement.setAttribute('height', iconPx);
            // Ensure it centers nicely even if the SVG has its own internal sizing.
            try {
                this.svgElement.style.display = 'block';
            } catch {
                /* ignore */
            }
            
            // Set initial color
            this.updateColor();
            
            if (this.onChange) {
                this.input.addEventListener('change', (e) => {
                    this.updateColor();
                    this.onChange(e.target.checked);
                });
            }
            
            // If we have a pending mount, execute it now
            if (this._pendingMount) {
                this._pendingMount.appendChild(this.element);
                this._pendingMount = null;
            }
        } catch (error) {
            console.error('Failed to load SVG:', error);
        }
    }
    
    updateColor() {
        if (!this.svgElement) return;
        
        const color = this.input.checked ? this.colorOn : this.colorOff;
        
        // Update all fill attributes in the SVG
        const elementsWithFill = this.svgElement.querySelectorAll('[fill]');
        elementsWithFill.forEach(el => {
            el.setAttribute('fill', color);
        });
        
        // If no elements have fill, set it on the root
        if (elementsWithFill.length === 0) {
            this.svgElement.setAttribute('fill', color);
        }
        
        // Also handle paths without explicit fill
        const paths = this.svgElement.querySelectorAll('path:not([fill])');
        paths.forEach(path => {
            path.setAttribute('fill', color);
        });
    }
    
    create() {
        // Create label container
        const label = document.createElement('label');
        label.style.cssText = `
            position: relative;
            display: inline-block;
            cursor: pointer;
            width: ${this.size}px;
            height: ${this.size}px;
        `;
        
        // Create hidden checkbox
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = this.checked;
        input.style.cssText = `
            position: absolute;
            opacity: 0;
            width: 0;
            height: 0;
        `;
        
        // Create SVG container
        const svgContainer = document.createElement('div');
        svgContainer.className = 'svg-container';
        svgContainer.style.cssText = `
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: opacity 0.2s ease, transform 0.1s ease;
            user-select: none;
        `;
        
        // Add hover effect
        label.addEventListener('mouseenter', () => {
            svgContainer.style.opacity = '0.8';
        });
        label.addEventListener('mouseleave', () => {
            svgContainer.style.opacity = '1';
        });
        
        // Add active effect
        label.addEventListener('mousedown', () => {
            svgContainer.style.transform = 'scale(0.95)';
        });
        label.addEventListener('mouseup', () => {
            svgContainer.style.transform = 'scale(1)';
        });
        label.addEventListener('mouseleave', () => {
            svgContainer.style.transform = 'scale(1)';
        });
        
        label.appendChild(input);
        label.appendChild(svgContainer);
        
        return label;
    }
    
    mount(container) {
        if (typeof container === 'string') {
            container = document.querySelector(container);
        }
        if (container) {
            if (this.element) {
                container.appendChild(this.element);
            } else {
                // SVG not loaded yet, store container for later
                this._pendingMount = container;
            }
        }
        return this;
    }
    
    toggle() {
        if (!this.input) return;
        this.input.checked = !this.input.checked;
        this.updateColor();
        this.input.dispatchEvent(new Event('change'));
    }
    
    setChecked(checked) {
        if (!this.input) return;
        this.input.checked = checked;
        this.updateColor();
    }
    
    isChecked() {
        return this.input ? this.input.checked : false;
    }
}
