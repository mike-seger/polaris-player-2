(function () {
    function markReady() {
        document.documentElement.classList.add('icons-ready');
    }
    try {
        if (document.fonts && typeof document.fonts.load === 'function') {
            Promise.race([
                document.fonts.load("1em 'Material Icons Round-Regular'"),
                new Promise((resolve) => setTimeout(resolve, 1500))
            ]).then(markReady, markReady);
        } else {
            setTimeout(markReady, 0);
        }
    } catch (e) {
        markReady();
    }
})();
