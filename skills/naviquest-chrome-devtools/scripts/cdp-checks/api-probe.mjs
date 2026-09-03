// Probe Chrome's page-JavaScript capabilities on the attached non-opaque origin.
// Capability is evidence, not an adoption decision: this records both APIs the
// SDK uses and nearby proposals whose absence or semantics rule them out.

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

export async function run(cdp) {
  await cdp.send('Runtime.enable');
  const result = await evaluate(cdp, `(async () => {
    const present = (value) => typeof value !== 'undefined';
    const availability = async (name, options = {}) => {
      const ctor = globalThis[name];
      if (!ctor) return 'absent';
      try { return await ctor.availability(options); }
      catch (error) { return 'threw:' + error.name; }
    };
    const workerAI = await new Promise((resolve) => {
      const source = 'postMessage({LanguageModel:typeof LanguageModel,Summarizer:typeof Summarizer,Translator:typeof Translator,LanguageDetector:typeof LanguageDetector,SemanticEmbedder:typeof SemanticEmbedder})';
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      worker.onmessage = (event) => { resolve(event.data); worker.terminate(); };
      worker.onerror = () => { resolve({ error: true }); worker.terminate(); };
    });
    return {
      webmcp: present(document.modelContext),
      computedRole: 'computedRole' in Element.prototype,
      computedName: 'computedName' in Element.prototype,
      getComputedAccessibleNode: present(globalThis.getComputedAccessibleNode),
      userActivation: {
        present: present(navigator.userActivation),
        isActive: navigator.userActivation?.isActive ?? null,
        hasBeenActive: navigator.userActivation?.hasBeenActive ?? null,
      },
      IntersectionObserver: present(globalThis.IntersectionObserver),
      highlightsFromPoint: present(CSS.highlightsFromPoint),
      highlights: present(CSS.highlights),
      Highlight: present(globalThis.Highlight),
      StaticRange: present(globalThis.StaticRange),
      fragmentDirective: present(document.fragmentDirective),
      Sanitizer: present(globalThis.Sanitizer),
      setHTML: 'setHTML' in Element.prototype,
      setHTMLUnsafe: 'setHTMLUnsafe' in Element.prototype,
      checkVisibility: 'checkVisibility' in Element.prototype,
      Segmenter: present(Intl.Segmenter),
      Locale: present(Intl.Locale),
      DisplayNames: present(Intl.DisplayNames),
      schedulerYield: present(globalThis.scheduler?.yield),
      locks: present(navigator.locks),
      caches: present(globalThis.caches),
      ariaLabelledByElements: 'ariaLabelledByElements' in Element.prototype,
      ariaControlsElements: 'ariaControlsElements' in Element.prototype,
      URLPattern: present(globalThis.URLPattern),
      ariaNotify: 'ariaNotify' in Element.prototype,
      moveBefore: 'moveBefore' in Element.prototype,
      Observable: present(globalThis.Observable),
      getHTML: 'getHTML' in Element.prototype,
      ToggleEvent: present(globalThis.ToggleEvent),
      scrollend: 'onscrollend' in document,
      navigation: present(globalThis.navigation),
      layoutShift: PerformanceObserver.supportedEntryTypes.includes('layout-shift'),
      ai: {
        LanguageModel: await availability('LanguageModel'),
        Summarizer: await availability('Summarizer'),
        Translator: await availability('Translator', { sourceLanguage: 'es', targetLanguage: 'en' }),
        LanguageDetector: await availability('LanguageDetector'),
        SemanticEmbedder: await availability('SemanticEmbedder', { taskType: 'retrieval-query' }),
        worker: workerAI,
      },
    };
  })()`);
  console.log('[CHROME_API_PROBE] ' + JSON.stringify(result, null, 2));
}
